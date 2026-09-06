import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, markUsed, embedUpgrade } from "../extensions/lib/db.ts";
import { vecMode } from "../extensions/lib/vec.ts";
import type { Embedder } from "../extensions/lib/embeddings.ts";
import { setActiveEmbedder, embed } from "../extensions/lib/embeddings.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv2-")), "memory.db");
}

test("vec loader never throws, mode is vec0 or js", () => {
  const db = openMindvault(tmpDb());
  assert.ok(vecMode(db) === "vec0" || vecMode(db) === "js");
  db.close();
});

test("vector match outranks unrelated FTS noise", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "zebras love explicit types grammar", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  remember(db, { peer: "u", content: "unrelated banana pancakes morning", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  const hits = recallSearch(db, { query: "explicit types", scopeKeys: ["dir:/a"], limit: 5 });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].content.includes("explicit"));
  assert.ok(hits[0].source === "vec" || hits[0].source === "fts" || hits[0].source === "like" || hits[0].source === "rrf" || hits[0].source.includes("+"));
  db.close();
});

function accessesOf(db: ReturnType<typeof openMindvault>, id: number): number {
  return (db.prepare("SELECT accesses FROM observations WHERE id=?").get(id) as { accesses: number }).accesses;
}

test("recall increments accesses on returned hits", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "we use sqlite for local memory", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  assert.equal(accessesOf(db, id), 0);
  recallSearch(db, { query: "sqlite memory", scopeKeys: ["dir:/a"], limit: 5 });
  assert.equal(accessesOf(db, id), 1);
  recallSearch(db, { query: "sqlite memory", scopeKeys: ["dir:/a"], limit: 5 });
  assert.equal(accessesOf(db, id), 2);
  db.close();
});

test("frequently-used memory ranks above an equal-relevance rival", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "postgres is the primary datastore", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  const hot = remember(db, { peer: "u", content: "postgres is the primary datastore", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  db.prepare("UPDATE observations SET accesses=10 WHERE id=?").run(hot);
  const hits = recallSearch(db, { query: "postgres datastore", scopeKeys: ["dir:/a"], limit: 5 });
  assert.equal(hits[0].id, hot);
  db.close();
});

test("markUsed bumps accesses and records feedback", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "prefers tabs over spaces", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  recallSearch(db, { query: "tabs spaces", scopeKeys: ["dir:/a"], limit: 5 });
  const before = accessesOf(db, id);
  const n = markUsed(db, [id]);
  assert.equal(n, 1);
  assert.equal(accessesOf(db, id), before + 1);
  const row = db.prepare("SELECT used_ids_json FROM recall_log ORDER BY id DESC LIMIT 1").get() as { used_ids_json: string | null };
  assert.deepEqual(JSON.parse(row.used_ids_json ?? "[]"), [id]);
  db.close();
});

test("explicit boost wins ties", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "deploy on fridays is fine", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  remember(db, { peer: "u", content: "never deploy on fridays", memType: "semantic", scopeKey: "dir:/a", explicit: 1, cwd: "/a" });
  const hits = recallSearch(db, { query: "deploy fridays", scopeKeys: ["dir:/a"], limit: 5 });
  assert.ok(hits[0].content.includes("never deploy"));
  db.close();
});

class StubEmbedder implements Embedder {
  readonly name = "stub";
  constructor(readonly dim: number, private table: Record<string, number[]>) {}
  async embed(text: string): Promise<Float32Array> {
    return Float32Array.from(this.table[text] ?? new Array(this.dim).fill(0).map((_, i) => (i === this.dim - 1 ? 1 : 0)));
  }
}

class ThrowingEmbedder implements Embedder {
  readonly name = "local:broken";
  readonly dim = 8;
  async embed(): Promise<Float32Array> {
    throw new Error("model runtime unavailable");
  }
}

test("async provider: semantic query with no lexical overlap retrieves the related memory", async () => {
  setActiveEmbedder(new StubEmbedder(4, { alpha: [1, 0, 0, 0], beta: [0, 1, 0, 0], omega: [0.95, 0.31, 0, 0] }));
  try {
    const db = openMindvault(tmpDb());
    const a = remember(db, { peer: "u", content: "alpha", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
    remember(db, { peer: "u", content: "beta", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM observations WHERE embedding IS NULL").get() as { n: number }).n, 2);
    await embedUpgrade(db);
    const qv = await embed("omega");
    const hits = recallSearch(db, { query: "omega", scopeKeys: ["dir:/a"], queryVector: qv, limit: 5 });
    assert.equal(hits[0].id, a);
    db.close();
  } finally {
    setActiveEmbedder(null);
  }
});

test("async provider falls back to feature-hash when the model runtime throws", async () => {
  setActiveEmbedder(new ThrowingEmbedder());
  try {
    const db = openMindvault(tmpDb());
    const id = remember(db, { peer: "u", content: "resilient note about widgets", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
    await embedUpgrade(db);
    const row = db.prepare("SELECT embedding FROM observations WHERE id=?").get(id) as { embedding: Buffer | null };
    assert.ok(row.embedding);
    const qv = await embed("widgets");
    const hits = recallSearch(db, { query: "widgets", scopeKeys: ["dir:/a"], queryVector: qv, limit: 5 });
    assert.ok(hits.some((h) => h.content.includes("widgets")));
    db.close();
  } finally {
    setActiveEmbedder(null);
  }
});

test("switching embedding model nulls stored vectors for re-embed", async () => {
  const path = tmpDb();
  setActiveEmbedder(null);
  let db = openMindvault(path);
  const id = remember(db, { peer: "u", content: "switch me over", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  assert.ok((db.prepare("SELECT embedding FROM observations WHERE id=?").get(id) as { embedding: Buffer | null }).embedding);
  db.close();
  setActiveEmbedder(new StubEmbedder(4, { "switch me over": [0, 0, 1, 0] }));
  try {
    db = openMindvault(path);
    assert.equal((db.prepare("SELECT embedding FROM observations WHERE id=?").get(id) as { embedding: Buffer | null }).embedding, null);
    await embedUpgrade(db);
    assert.ok((db.prepare("SELECT embedding FROM observations WHERE id=?").get(id) as { embedding: Buffer | null }).embedding);
    db.close();
  } finally {
    setActiveEmbedder(null);
  }
});
