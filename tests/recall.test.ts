import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, markUsed } from "../extensions/lib/db.ts";
import { vecMode } from "../extensions/lib/vec.ts";

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
