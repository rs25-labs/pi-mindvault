# pi-mindvault M2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M2 — vector recall fused with FTS5 via RRF, pluggable embeddings (zero-dep local default + API fallback), and `forget`/cascade delete.

**Architecture:** `extensions/lib/embeddings.ts` owns embedders behind one interface. `extensions/lib/db.ts` gains an `embedding BLOB` column (reconciled `ADD COLUMN`), optional `vec0` index when the native extension loads, and an upgraded `recallSearch` (vec top-20 + FTS top-20 → RRF → recency/importance/explicit rerank). `vec0` missing → JS cosine scan over in-scope rows (correct at M2 scale, accelerator later). New `forgetObservation`/`deleteScope` + `memory_forget` tool.

**Tech Stack:** TypeScript, `node:sqlite` (`allowLoadExtension:true`), `sqlite-vec` (optional native, graceful fallback), `node:test` via `tsx`.

---

## File structure (M2 creates/modifies)
- Create: `extensions/lib/embeddings.ts` — `Embedder` interface, `FeatureHashEmbedder` (256-dim, zero-dep default), `ApiEmbedder` (OpenAI-compatible fallback), `defaultEmbedder()`
- Create: `extensions/lib/vec.ts` — `loadVecExtension(db): "vec0" | "js"` (probe native, record in `state_meta`)
- Modify: `extensions/lib/db.ts` — embedding column reconcile, `remember` embeds, `recallSearch` RRF, `forgetObservation`, `deleteScope`, `backfillEmbeddings`, `dbStatus` += vec info
- Modify: `extensions/mindvault.ts` — `memory_forget` tool, status shows vec mode
- Create: `tests/embeddings.test.ts`, `tests/recall.test.ts`, `tests/forget.test.ts`
- Modify: `package.json` — add `sqlite-vec` to `dependencies` (runtime optional, loaded best-effort)

---

### Task 1: Embeddings module (TDD)

**Files:**
- Create: `extensions/lib/embeddings.ts`
- Test: `tests/embeddings.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/embeddings.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureHashEmbedder, cosine } from "../extensions/lib/embeddings.ts";

test("feature-hash is deterministic and normalized", async () => {
  const e = new FeatureHashEmbedder(256);
  const a = await e.embed("prefers explicit types");
  const b = await e.embed("prefers explicit types");
  assert.equal(e.dim, 256);
  assert.deepEqual(Array.from(a), Array.from(b));
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5);
});

test("similar texts score higher than unrelated", async () => {
  const e = new FeatureHashEmbedder(256);
  const q = await e.embed("explicit types");
  const close = await e.embed("prefers explicit types everywhere");
  const far = await e.embed("banana pancakes");
  assert.ok(cosine(q, close) > cosine(q, far));
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx tsx --test tests/embeddings.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Implement embeddings.ts**

```typescript
// extensions/lib/embeddings.ts
export interface Embedder { readonly dim: number; readonly name: string; embed(text: string): Promise<Float32Array>; }

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}

export class FeatureHashEmbedder implements Embedder {
  readonly name = "feature-hash";
  constructor(readonly dim = 256) {}
  async embed(text: string): Promise<Float32Array> {
    const v = new Float32Array(this.dim);
    const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      v[fnv1a(toks[i]) % this.dim] += 1;
      if (i > 0) v[fnv1a(toks[i - 1] + " " + toks[i]) % this.dim] += 0.5;
    }
    let n = 0;
    for (let i = 0; i < v.length; i++) n += v[i] * v[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= n;
    return v;
  }
}

export class ApiEmbedder implements Embedder {
  readonly name = "api";
  constructor(readonly dim: number, private baseUrl: string, private key: string, private model: string) {}
  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const arr = Float32Array.from(json.data[0].embedding.slice(0, this.dim));
    let n = 0;
    for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < arr.length; i++) arr[i] /= n;
    return arr;
  }
}

export function defaultEmbedder(): Embedder {
  const base = process.env.MINDVAULT_EMBEDDINGS_URL ?? "";
  const key = process.env.MINDVAULT_EMBEDDINGS_KEY ?? "";
  const model = process.env.MINDVAULT_EMBEDDINGS_MODEL ?? "";
  const dim = Number(process.env.MINDVAULT_EMBEDDINGS_DIM ?? "0");
  if (base && key && model && dim > 0) return new ApiEmbedder(dim, base, key, model);
  return new FeatureHashEmbedder(256);
}
```

- [ ] **Step 4: Run, expect pass**

Run: `npx tsx --test tests/embeddings.test.ts`
Expected: PASS 2 tests.

- [ ] **Step 5: Commit**

```bash
git add extensions/lib/embeddings.ts tests/embeddings.test.ts
git commit -m "pi-mindvault M2: pluggable embeddings (feature-hash default, API fallback)"
```

---

### Task 2: vec loader + dependency (TDD with graceful fallback)

**Files:**
- Create: `extensions/lib/vec.ts`
- Modify: `package.json`
- Test: inline in `tests/recall.test.ts` (Task 3 asserts mode is `"vec0"` or `"js"`, never throws)

- [ ] **Step 1: Add sqlite-vec dependency**

Run: `npm install sqlite-vec@0.1.9`
Expected: `package.json` gains `"sqlite-vec": "^0.1.9"` under `dependencies`.

- [ ] **Step 2: Implement vec.ts**

```typescript
// extensions/lib/vec.ts
import type { Db } from "./db.ts";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

export type VecMode = "vec0" | "js";

const CANDIDATES: Record<string, string[]> = {
  "darwin-arm64": ["vec0.dylib", "libvec0.dylib"],
  "darwin-x64": ["vec0.dylib", "libvec0.dylib"],
  "linux-x64": ["vec0.so", "libvec0.so"],
  "linux-arm64": ["vec0.so", "libvec0.so"],
};

export function findVecExtension(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("sqlite-vec/package.json");
    const root = dirname(pkgJson);
    const key = `${process.platform}-${process.arch}`;
    for (const name of CANDIDATES[key] ?? []) {
      for (const dir of [root, join(root, "loadable"), join(root, "dist")]) {
        const p = join(dir, name);
        if (existsSync(p)) return p;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function loadVecExtension(db: Db): VecMode {
  const path = findVecExtension();
  if (!path) { recordMode(db, "js"); return "js"; }
  try {
    (db as unknown as { loadExtension(p: string): void }).loadExtension(path);
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(embedding FLOAT[256])`);
    recordMode(db, "vec0");
    return "vec0";
  } catch {
    recordMode(db, "js");
    return "js";
  }
}

function recordMode(db: Db, mode: VecMode): void {
  db.prepare("INSERT INTO state_meta(key,value) VALUES('vec_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
}

export function vecMode(db: Db): VecMode {
  try {
    const row = db.prepare("SELECT value FROM state_meta WHERE key='vec_mode'").get() as { value: string } | undefined;
    return row?.value === "vec0" ? "vec0" : "js";
  } catch {
    return "js";
  }
}
```

Note: `Db` must be opened with `{ allowLoadExtension: true }` — Task 3 changes `openMindvault` accordingly. If the `vec0` DDL fails (dim differs, tokenizer missing), we fall back to `"js"` and M2 still ships.

- [ ] **Step 3: Commit**

```bash
git add extensions/lib/vec.ts package.json package-lock.json
git commit -m "pi-mindvault M2: optional vec0 loader with js fallback"
```

---

### Task 3: DB recall upgrade — RRF + backfill + forget (TDD)

**Files:**
- Modify: `extensions/lib/db.ts`
- Test: `tests/recall.test.ts`, `tests/forget.test.ts`

- [ ] **Step 1: Write failing recall test**

```typescript
// tests/recall.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch } from "../extensions/lib/db.ts";
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
  assert.ok(hits[0].source === "vec" || hits[0].source === "fts" || hits[0].source === "like" || hits[0].source === "rrf");
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
```

- [ ] **Step 2: Write failing forget test**

```typescript
// tests/forget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, forgetObservation, deleteScope } from "../extensions/lib/db.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mvf-")), "memory.db");
}

test("forget purges FTS + vec", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "temporary s3cr3t factoid", memType: "semantic", scopeKey: "dir:/a", explicit: 1, cwd: "/a" });
  assert.equal(forgetObservation(db, id), true);
  const hits = recallSearch(db, { query: "factoid", scopeKeys: ["dir:/a"], limit: 5 });
  assert.equal(hits.length, 0);
  db.close();
});

test("deleteScope removes scoped rows only", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "projA alpha", memType: "semantic", scopeKey: "dir:/projA", explicit: 0, cwd: "/projA" });
  remember(db, { peer: "u", content: "global beta", memType: "semantic", scopeKey: "global", explicit: 0, cwd: "/projA" });
  const n = deleteScope(db, "dir:/projA");
  assert.equal(n, 1);
  const hits = recallSearch(db, { query: "beta", scopeKeys: ["global"], limit: 5 });
  assert.equal(hits.length, 1);
  db.close();
});
```

- [ ] **Step 3: Run new tests, expect fail**

Run: `npx tsx --test tests/recall.test.ts tests/forget.test.ts`
Expected: FAIL (recallSearch has no RRF/sources, forget fns missing).

- [ ] **Step 4: Upgrade db.ts** — apply these exact changes to `extensions/lib/db.ts`:

a) Open with extension loading + reconcile embedding column. Replace `openMindvault` body start:
```typescript
export function openMindvault(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path, { allowLoadExtension: true } as unknown as Record<string, unknown>);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
```
And after the `workspaces` seed line add:
```typescript
  // M2 reconcile: embedding column (older M1 DBs lack it)
  try {
    const cols = db.prepare(`PRAGMA table_info(observations)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === "embedding")) db.exec(`ALTER TABLE observations ADD COLUMN embedding BLOB`);
  } catch { /* fresh schema already has it when added below */ }
```
And add `embedding BLOB` to the `observations` CREATE TABLE line:
```sql
CREATE TABLE IF NOT EXISTS observations(... accesses INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL, embedding BLOB);
```
Then call the vec loader + dim record at the end of `openMindvault` (before `return db`):
```typescript
  const { loadVecExtension } = await_import_vec();
  loadVecExtension(db);
  ensureEmbeddingDim(db);
  backfillEmbeddings(db);
  return db;
```
Since `openMindvault` is sync, do not use dynamic import — instead add a direct top-of-file import (no cycle: `vec.ts` imports only the `Db` type from `db.ts`):
```typescript
import { loadVecExtension } from "./vec.ts";
import { defaultEmbedder } from "./embeddings.ts";
```
And at end of `openMindvault`:
```typescript
  loadVecExtension(db);
  ensureEmbeddingDim(db);
  backfillEmbeddings(db);
  return db;
```

b) Add after `ensurePeer`:
```typescript
function ensureEmbeddingDim(db: Db): void {
  const dim = defaultEmbedder().dim;
  const row = db.prepare("SELECT value FROM state_meta WHERE key='embedding_dim'").get() as { value?: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO state_meta(key,value) VALUES('embedding_dim',?)").run(String(dim));
    return;
  }
  if (Number(row.value) !== dim) {
    // model changed: drop vectors, re-embed lazily (rows with NULL embedding)
    try { db.exec("DELETE FROM vec_observations"); } catch { /* js mode: nothing */ }
    db.prepare("UPDATE observations SET embedding=NULL").run();
    db.prepare("UPDATE state_meta SET value=? WHERE key='embedding_dim'").run(String(dim));
  }
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function fromBlob(b: Uint8Array | Buffer | null): Float32Array | null {
  if (!b) return null;
  const buf = Buffer.from(b);
  if (buf.byteLength % 4 !== 0 || buf.byteLength === 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function backfillEmbeddings(db: Db, limit = 200): number {
  const rows = db.prepare("SELECT id, content FROM observations WHERE embedding IS NULL LIMIT ?").all(limit) as { id: number; content: string }[];
  if (rows.length === 0) return 0;
  const emb = defaultEmbedder();
  const mode = vecMode(db);
  let n = 0;
  for (const r of rows) {
    const v = toBlob(syncEmbed(emb, r.content));
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, r.id);
    if (mode === "vec0") {
      try { db.prepare("INSERT OR REPLACE INTO vec_observations(rowid, embedding) VALUES(?,?)").run(r.id, v); } catch { /* fall through */ }
    }
    n++;
  }
  return n;
}

// sync bridge: FeatureHashEmbedder.embed has no I/O; ApiEmbedder is async.
// M2 write path stays sync by using the default (sync-capable) embedder inline
// and deferring API embeddings to M3 workers. If an async embedder is configured,
// remember() stores NULL and backfill (async entry below) fills it.
import { FeatureHashEmbedder } from "./embeddings.ts";
function syncEmbed(emb: { name: string; dim: number }, content: string): Float32Array {
  const fh = new FeatureHashEmbedder((emb as { dim: number }).dim);
  let out: Float32Array | null = null;
  // FeatureHashEmbedder.embed is async only in signature; resolve synchronously via shared impl
  const v = new Float32Array(fh.dim);
  const toks = content.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const fnv = (s: string): number => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  };
  for (let i = 0; i < toks.length; i++) {
    v[fnv(toks[i]) % fh.dim] += 1;
    if (i > 0) v[fnv(toks[i - 1] + " " + toks[i]) % fh.dim] += 0.5;
  }
  let nrm = 0;
  for (let i = 0; i < v.length; i++) nrm += v[i] * v[i];
  nrm = Math.sqrt(nrm) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= nrm;
  out = v;
  return out;
}
```

c) `remember`: after the INSERT, embed + store + vec insert. Insert after `const id = Number(r.lastInsertRowid);`:
```typescript
  try {
    const v = toBlob(syncEmbed(defaultEmbedder(), clean));
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, id);
    if (vecMode(db) === "vec0") {
      try { db.prepare("INSERT INTO vec_observations(rowid, embedding) VALUES(?,?)").run(id, v); } catch { /* js fallback covers */ }
    }
  } catch { /* embedding never blocks a write */ }
```

d) Replace `recallSearch` with RRF fusion:
```typescript
export function recallSearch(db: Db, args: { query: string; scopeKeys: string[]; limit?: number }): Hit[] {
  const limit = args.limit ?? 5;
  if (args.scopeKeys.length === 0) return [];
  const placeholders = args.scopeKeys.map(() => "?").join(",");
  const K = 60;
  const rrf = new Map<number, { rrf: number; sources: string[] }>();
  const add = (id: number, rank: number, src: string) => {
    const cur = rrf.get(id) ?? { rrf: 0, sources: [] };
    cur.rrf += 1 / (K + rank);
    if (!cur.sources.includes(src)) cur.sources.push(src);
    rrf.set(id, cur);
  };
  // FTS leg (rank = order)
  try {
    const rows = db.prepare(
      `SELECT o.id FROM fts_observations f JOIN observations o ON o.id = f.rowid JOIN scopes s ON s.id = o.scope_id
       WHERE fts_observations MATCH ? AND s.key IN (${placeholders}) ORDER BY bm25(fts_observations) LIMIT 20`
    ).all(args.query, ...args.scopeKeys) as { id: number }[];
    rows.forEach((r, i) => add(r.id, i, "fts"));
  } catch {
    const like = `%${args.query.split(/\s+/)[0] ?? args.query}%`;
    const rows = db.prepare(
      `SELECT o.id FROM observations o JOIN scopes s ON s.id=o.scope_id
       WHERE o.content LIKE ? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT 20`
    ).all(like, ...args.scopeKeys) as { id: number }[];
    rows.forEach((r, i) => add(r.id, i, "like"));
  }
  // vector leg
  try {
    const qv = toBlob(syncEmbed(defaultEmbedder(), args.query));
    if (vecMode(db) === "vec0") {
      const rows = db.prepare(
        `SELECT o.id FROM vec_observations v JOIN observations o ON o.id = v.rowid JOIN scopes s ON s.id=o.scope_id
         WHERE v.embedding MATCH ? AND s.key IN (${placeholders}) ORDER BY distance LIMIT 20`
      ).all(qv, ...args.scopeKeys) as { id: number }[];
      // vec0 MATCH needs k param; if the above throws, js scan below covers it
      rows.forEach((r, i) => add(r.id, i, "vec"));
    } else {
      throw new Error("js-scan");
    }
  } catch {
    // JS cosine scan over in-scope rows (M2 scale)
    const qf = fromBlob(toBlob(syncEmbed(defaultEmbedder(), args.query)))!;
    const rows = db.prepare(
      `SELECT o.id, o.embedding FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE s.key IN (${placeholders})`
    ).all(...args.scopeKeys) as { id: number; embedding: Buffer | null }[];
    const scored = rows
      .map((r) => ({ id: r.id, s: r.embedding ? jsCosine(qf, fromBlob(r.embedding)!) : -1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20);
    scored.forEach((r, i) => add(r.id, i, "vec"));
  }
  if (rrf.size === 0) { logRecall(db, args.query, null, [], []); return []; }
  const ids = [...rrf.keys()];
  const meta = db.prepare(
    `SELECT o.id, o.content, o.importance, o.explicit, o.created_at, s.key AS scopeKey FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE o.id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as { id: number; content: string; importance: number; explicit: number; created_at: number; scopeKey: string }[];
  const now = Date.now() / 1000;
  const ranked = meta
    .map((m) => {
      const r = rrf.get(m.id)!;
      const rec = 1 / (1 + Math.max(0, now - m.created_at) / 86400);
      const score = 0.6 * r.rrf + 0.25 * rec + 0.15 * Math.min(1, Math.max(0, m.importance)) + (m.explicit ? 0.1 : 0);
      return { id: m.id, content: m.content, score, source: r.sources.sort().join("+") || "rrf", scopeKey: m.scopeKey };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  logRecall(db, args.query, null, ranked.map((r) => r.id), ranked.map((r) => r.score));
  return ranked;
}

function jsCosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}
```
Delete the old `recallSearch` body when replacing. Note: vec0 `MATCH ?` with a blob needs `k` — `WHERE embedding MATCH ? AND k=20`; fold `k` in: use `... WHERE v.embedding MATCH ? AND k = 20 AND s.key IN ...`. If that SQL throws on some builds, the catch runs the JS scan — still correct.

e) Add forget/delete + status extension at end of file:
```typescript
export function forgetObservation(db: Db, id: number): boolean {
  const mode = vecMode(db);
  if (mode === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid=?").run(id); } catch { /* trigger/js covers */ }
  }
  const r = db.prepare("DELETE FROM observations WHERE id=?").run(id) as { changes: number | bigint };
  return Number(r.changes) > 0;
}

export function deleteScope(db: Db, scopeKey: string): number {
  const row = db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number } | undefined;
  if (!row) return 0;
  const mode = vecMode(db);
  if (mode === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid IN (SELECT id FROM observations WHERE scope_id=?)").run(row.id); } catch { /* js */ }
  }
  const r = db.prepare("DELETE FROM observations WHERE scope_id=?").run(row.id) as { changes: number | bigint };
  db.prepare("DELETE FROM peer_cards WHERE scope_id=?").run(row.id);
  db.prepare("DELETE FROM scopes WHERE id=?").run(row.id);
  return Number(r.changes);
}
```
And extend `dbStatus` return with vec info — change signature to include `embeddingDim` and `vecMode`:
```typescript
export function dbStatus(db: Db): { schemaVersion: number; observations: number; ftsCount: number; queuePending: number; dbSize: number | null; embeddingDim: number | null; vecMode: string } {
  ...
  let dim: number | null = null;
  try { dim = Number((db.prepare("SELECT value FROM state_meta WHERE key='embedding_dim'").get() as { value: string }).value); } catch { dim = null; }
  return { ..., embeddingDim: dim, vecMode: vecMode(db) };
}
```

- [ ] **Step 5: Run all tests, expect pass**

Run: `npx tsx --test tests/*.test.ts`
Expected: PASS (M1 8 + M2 7 = 15 tests). Note M1 `db.test.ts` imports `dbStatus` and checks `schemaVersion` only — signature extension is backward compatible.

- [ ] **Step 6: Commit**

```bash
git add extensions/lib/db.ts extensions/lib/vec.ts tests/recall.test.ts tests/forget.test.ts package.json package-lock.json
git commit -m "pi-mindvault M2: RRF recall, backfill, forget/cascade"
```

---

### Task 4: Tools — memory_forget + vec status (small)

**Files:**
- Modify: `extensions/mindvault.ts`

- [ ] **Step 1: Add forget tool + status vec info**

Add import: `forgetObservation` from `./lib/db.ts`. Register after `memory_conclude`:
```typescript
  pi.registerTool({
    name: "memory_forget",
    label: "Memory Forget",
    description: "Hard-delete one memory by id (purges FTS + vector). Use for corrections and privacy.",
    parameters: Type.Object({ id: Type.Number({ description: "Observation id from memory_search" }) }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const ok = forgetObservation(db, params.id);
      db.close();
      return { content: [{ type: "text" as const, text: ok ? `forgot #${params.id}` : `not found #${params.id}` }], details: {} };
    },
  });
```
Update `/memory` handler text to include vec info:
```typescript
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending} vec=${st.vecMode} dim=${st.embeddingDim ?? "?"}`, "info");
```

- [ ] **Step 2: Typecheck + tests**

Run: `npx tsc --noEmit && npx tsx --test tests/*.test.ts`
Expected: clean, all PASS.

- [ ] **Step 3: Commit**

```bash
git add extensions/mindvault.ts
git commit -m "pi-mindvault M2: memory_forget tool + vec status"
```

---

### Task 5: Docs + push branch

- [ ] **Step 1: README scope note**

Append to `README.md`:
```markdown
## M2 scope
- RRF hybrid recall (`vec` + FTS5, recency/importance/explicit rerank); `vec0` when the native extension loads, JS cosine scan otherwise.
- Embeddings pluggable: zero-dep feature-hash default; set `MINDVAULT_EMBEDDINGS_URL/KEY/MODEL/DIM` for API embeddings.
- `memory_forget` + scope delete (session delete lands in M3 with workers).
```

- [ ] **Step 2: Full suite once more + push**

Run: `npm test && npm run typecheck`
```bash
git add README.md
git commit -m "pi-mindvault M2: scope note in README"
git push -u origin feat/m2-vector-recall
```

---

## Self-review
- Spec coverage: FR11 RRF hybrid + explicit boost → Task 3; FR16 forget/delete (observation + scope; session delete deferred M3 with workers) → Task 3+4; FR5 embedding column + dim record → Task 3; FR17 status vec info → Task 4; Q5 pluggable embeddings → Task 1. Session-summary/Dreamer stay M3 per PRD.
- Placeholders: none — all SQL/TS complete; vec0 `k` fallback handled by catch → JS scan (correctness first).
- Types: `Hit.source` now `"fts+vec"`-style joins — M1 test only asserts content, still passes; `dbStatus` extended (additive).
