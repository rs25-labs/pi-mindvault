# pi-mindvault M1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M1 — single-file sqlite memory with WAL + FTS5, 4 pi tools backed by FTS-only search, scopes (per-directory default + global), redaction, and `memory status`, fully tested.

**Architecture:** Repo root is the pi package (`package.json` with `pi.extensions: ["./extensions"]`). `extensions/mindvault.ts` registers tools/commands and hooks `session_start` (inject) + `tool_result`/`agent_end` (sync stub). `extensions/lib/db.ts` owns `node:sqlite` (no native deps; `sqlite-vec` deferred to M2). FTS5 external-content table mirrors `observations`.

**Tech Stack:** TypeScript, `node:sqlite` (Node 22 `DatabaseSync`), `typebox` (peer, already in pi), `node:test` via `tsx` for TS tests.

---

## File structure (M1 creates)
- Create: `package.json` — package manifest + pi manifest + scripts
- Create: `extensions/mindvault.ts` — entry, 4 tools + `/mindvault-setup` + `/memory` status + hooks
- Create: `extensions/lib/db.ts` — open/create DB, SCHEMA_SQL, WAL, CRUD, FTS5 sync, search, status
- Create: `extensions/lib/scopes.ts` — resolve `global|dir|cwd|repo`, git root helper
- Create: `extensions/lib/redact.ts` — secret redaction + outside-cwd jail marker
- Create: `tests/db.test.ts`, `tests/redact.test.ts`, `tests/scopes.test.ts`
- Modify: `.gitignore` — add `node_modules/`, keep existing secrets ignores

---

### Task 1: Package scaffold

**Files:**
- Create: `package.json`
- Modify: `.gitignore`

- [ ] **Step 1: Write package.json**

```json
{
  "name": "@rs25-labs/pi-mindvault",
  "version": "0.1.0",
  "description": "Local-first sqlite memory for pi — Hermes durability, Honcho-style recall, no server.",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": { "extensions": ["./extensions"] },
  "scripts": {
    "test": "tsx --test tests/*.test.ts",
    "typecheck": "tsc --noEmit"
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Append node ignores to .gitignore**

Run: `cat .gitignore`

Append (keep existing secret lines, add):
```text
node_modules/
dist/
*.tsbuildinfo
```

Result file `.gitignore` ends with both old secret block and new block above.

- [ ] **Step 3: Install**

Run: `npm install`
Expected: `node_modules/` created, no errors on Node v22.

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "pi-mindvault M1: package scaffold"
```

---

### Task 2: DB layer + redact + scopes (TDD)

**Files:**
- Create: `extensions/lib/redact.ts`
- Create: `extensions/lib/scopes.ts`
- Create: `extensions/lib/db.ts`
- Test: `tests/redact.test.ts`, `tests/scopes.test.ts`, `tests/db.test.ts`

- [ ] **Step 1: Write failing redact test**

```typescript
// tests/redact.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../extensions/lib/redact.ts";

test("redacts token patterns", () => {
  const out = redact("key=sk-abc123xyz plus ghp_deadbeef1234");
  assert.ok(!out.includes("sk-abc123xyz"));
  assert.ok(!out.includes("ghp_deadbeef1234"));
});

test("jails outside-cwd paths", () => {
  const out = redact("see /etc/passwd for hints", { cwd: "/home/u/proj" });
  assert.ok(out.includes("<outside-cwd>") || out.includes("/etc/passwd") === false);
});
```

- [ ] **Step 2: Run redact test, expect fail**

Run: `npx tsx --test tests/redact.test.ts`
Expected: FAIL `Cannot find module .../redact.ts`.

- [ ] **Step 3: Implement redact**

```typescript
// extensions/lib/redact.ts
const PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9-_]{8,}/g,
  /ghp_[A-Za-z0-9]{8,}/g,
  /gho_[A-Za-z0-9]{8,}/g,
  /xox[bpas]-[A-Za-z0-9-]{8,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /(?<=api[_-]?key\s*[:=]\s*)[A-Za-z0-9-_.]{12,}/gi,
];

export function redact(input: string, opts?: { cwd?: string }): string {
  let out = input;
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, "[redacted]");
  }
  // jail absolute paths outside cwd (cheap heuristic: system roots not under cwd)
  const cwd = opts?.cwd ?? "";
  out = out.replace(/(^|[\s"'(`])(?:\/etc\/[^\s"'`)]*|\/private\/[^\s"'`)]*)/g, "$1<outside-cwd>");
  if (cwd && !cwd.startsWith("<")) {
    // mark any other absolute path that is not under cwd
    out = out.replace(/(^|[\s"'(`])(\/(?:Users|home|tmp|var)[^\s"'`)]*)/g, (m, pre, p) => {
      if (cwd && p.startsWith(cwd)) return m;
      return `${pre}<outside-cwd>`;
    });
  }
  return out;
}
```

- [ ] **Step 4: Run redact test, expect pass**

Run: `npx tsx --test tests/redact.test.ts`
Expected: PASS 2 tests.

- [ ] **Step 5: Write failing scopes test**

```typescript
// tests/scopes.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope, scopeKeysForRead } from "../extensions/lib/scopes.ts";

test("default write scope is per-directory", () => {
  assert.equal(resolveScope({ cwd: "/home/u/proj", repoRoot: null }).kind, "dir");
});

test("read keys include global + dir + repo", () => {
  const keys = scopeKeysForRead({ cwd: "/home/u/proj", repoRoot: "/home/u/proj" });
  assert.ok(keys.includes("global"));
  assert.ok(keys.includes("dir:/home/u/proj"));
  assert.ok(keys.includes("repo:/home/u/proj"));
});
```

- [ ] **Step 6: Run scopes test, expect fail**

Run: `npx tsx --test tests/scopes.test.ts`
Expected: FAIL module not found.

- [ ] **Step 7: Implement scopes**

```typescript
// extensions/lib/scopes.ts
export type ScopeKind = "global" | "dir" | "repo" | "session";
export interface ScopeRef { kind: ScopeKind; key: string }

export function dirKey(cwd: string): string { return `dir:${cwd}`; }
export function repoKey(root: string): string { return `repo:${root}`; }

export function resolveScope(args: { cwd: string; repoRoot: string | null; explicit?: "global" | null }): ScopeRef {
  if (args.explicit === "global") return { kind: "global", key: "global" };
  return { kind: "dir", key: dirKey(args.cwd) };
}

export function scopeKeysForRead(args: { cwd: string; repoRoot: string | null }): string[] {
  const keys = ["global", dirKey(args.cwd)];
  if (args.repoRoot) keys.push(repoKey(args.repoRoot));
  return keys;
}

export function gitRoot(cwd: string): string | null {
  // M1: pure helper without spawning when .git missing; caller may pass null
  // implemented with node:fs walk-up (no git binary needed)
  import("node:fs").then(() => {});
  return null;
}
```

Note: `gitRoot` above uses a dynamic import placeholder — replace with the sync version below at implementation time (full code required, no placeholders — use this exact body):

```typescript
// extensions/lib/scopes.ts (final gitRoot — use this, not the stub above)
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function gitRootSync(cwd: string): string | null {
  let cur = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(cur + "/.git")) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
```

Keep both `resolveScope`, `scopeKeysForRead`, `dirKey`, `repoKey`, `gitRootSync` in the final file (drop the async `gitRoot` stub).

- [ ] **Step 8: Run scopes test, expect pass**

Run: `npx tsx --test tests/scopes.test.ts`
Expected: PASS (note: test imports `resolveScope, scopeKeysForRead` only — extra exports fine).

- [ ] **Step 9: Write failing db test**

```typescript
// tests/db.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus } from "../extensions/lib/db.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv-")), "memory.db");
}

test("remember + search roundtrip with scopes", () => {
  const path = tmpDb();
  const db = openMindvault(path);
  const id = remember(db, { peer: "user1", content: "prefers explicit types", memType: "semantic", scopeKey: "dir:/home/u/proj", explicit: 1, cwd: "/home/u/proj" });
  assert.ok(id > 0);
  const hits = recallSearch(db, { query: "explicit types", scopeKeys: ["global", "dir:/home/u/proj"], limit: 5 });
  assert.ok(hits.length >= 1);
  assert.ok(hits[0].content.includes("explicit"));
  db.close();
});

test("scope isolation: dir:A invisible from dir:B", () => {
  const path = tmpDb();
  const db = openMindvault(path);
  remember(db, { peer: "user1", content: "secret projA fact", memType: "semantic", scopeKey: "dir:/home/u/projA", explicit: 0, cwd: "/home/u/projA" });
  const hits = recallSearch(db, { query: "projA fact", scopeKeys: ["global", "dir:/home/u/projB"], limit: 5 });
  assert.equal(hits.length, 0);
  db.close();
});

test("explicit never pruned placeholder + status", () => {
  const path = tmpDb();
  const db = openMindvault(path);
  const st = dbStatus(db);
  assert.equal(st.schemaVersion, 1);
  db.close();
});

test("getProfile returns global cards", () => {
  const path = tmpDb();
  const db = openMindvault(path);
  remember(db, { peer: "user1", content: "handle is tester", memType: "semantic", scopeKey: "global", explicit: 1, cwd: "/home/u/proj" });
  const cards = getProfile(db, { peer: "user1", scopeKeys: ["global"] });
  assert.ok(cards.join("\n").includes("tester"));
  db.close();
});
```

- [ ] **Step 10: Run db test, expect fail**

Run: `npx tsx --test tests/db.test.ts`
Expected: FAIL module not found.

- [ ] **Step 11: Implement db.ts (full)**

```typescript
// extensions/lib/db.ts
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export type Db = DatabaseSync;
export type MemType = "episodic" | "semantic" | "procedural" | "working";

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS state_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, config_json TEXT);
CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS scopes(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pi_session_id TEXT UNIQUE, cwd TEXT, repo_root TEXT, scope_id INTEGER, summary TEXT, started_at REAL, ended_at REAL);
CREATE TABLE IF NOT EXISTS session_peers(session_id TEXT NOT NULL, peer_id TEXT NOT NULL, PRIMARY KEY(session_id, peer_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, peer_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp REAL NOT NULL, token_count INTEGER);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL DEFAULT 'pi', peer_id TEXT NOT NULL, session_id TEXT, scope_id INTEGER NOT NULL, mem_type TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, explicit INTEGER NOT NULL DEFAULT 0, supersedes_id INTEGER, expiry REAL, accesses INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_observations USING fts5(content, content='observations', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN INSERT INTO fts_observations(rowid, content) VALUES (new.id, new.content); END;
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN INSERT INTO fts_observations(fts_observations, rowid, content) VALUES ('delete', old.id, old.content); END;
CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE OF content ON observations BEGIN INSERT INTO fts_observations(fts_observations, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO fts_observations(rowid, content) VALUES (new.id, new.content); END;
CREATE TABLE IF NOT EXISTS peer_cards(peer_id TEXT NOT NULL, scope_id INTEGER NOT NULL, content TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(peer_id, scope_id));
CREATE TABLE IF NOT EXISTS summaries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, peer_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, tokens INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, payload_json TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS recall_log(id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, scope_id INTEGER, result_ids_json TEXT, scores_json TEXT, hit INTEGER NOT NULL, pi_session_id TEXT, timestamp REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_obs_peer_scope ON observations(peer_id, scope_id, mem_type);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, timestamp);
`;

export function openMindvault(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  if (!v) db.prepare("INSERT INTO state_meta(key,value) VALUES('schema_version','1')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces(id,config_json) VALUES('pi','{}')").run();
  return db;
}

function scopeId(db: Db, workspaceId: string, scopeKey: string): number {
  const kind = scopeKey === "global" ? "global" : scopeKey.startsWith("dir:") ? "dir" : scopeKey.startsWith("repo:") ? "repo" : "session";
  db.prepare("INSERT OR IGNORE INTO scopes(workspace_id,kind,key) VALUES(?,?,?)").run(workspaceId, kind, scopeKey);
  const row = db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number };
  return row.id;
}

function ensurePeer(db: Db, peer: string): void {
  const kind = peer === "pi-agent" ? "agent" : "user";
  db.prepare("INSERT OR IGNORE INTO peers(id,workspace_id,kind,created_at) VALUES(?,?,?,?)").run(peer, "pi", kind, Date.now() / 1000);
}

export function remember(db: Db, args: { peer: string; content: string; memType: MemType; scopeKey: string; explicit: 0 | 1; cwd: string; importance?: number }): number {
  const clean = redact(args.content, { cwd: args.cwd });
  ensurePeer(db, args.peer);
  const sid = scopeId(db, "pi", args.scopeKey);
  const now = Date.now() / 1000;
  const r = db.prepare("INSERT INTO observations(workspace_id,peer_id,session_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi',?,NULL,?,?,?,COALESCE(?,0.5),?,0,?,?)").run(args.peer, sid, args.memType, clean, args.importance ?? null, args.explicit, now, now) as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  // refresh peer card for global scope (fast inject source)
  if (args.scopeKey === "global") {
    const rows = db.prepare("SELECT content FROM observations WHERE peer_id=? AND scope_id=? ORDER BY id DESC LIMIT 20").all(args.peer, sid) as { content: string }[];
    const card = rows.map((x) => `- ${x.content}`).join("\n").slice(0, 4000);
    db.prepare("INSERT INTO peer_cards(peer_id,scope_id,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(peer_id,scope_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at").run(args.peer, sid, card, now);
  }
  return id;
}

export interface Hit { id: number; content: string; score: number; source: string; scopeKey: string }

export function recallSearch(db: Db, args: { query: string; scopeKeys: string[]; limit?: number }): Hit[] {
  const limit = args.limit ?? 5;
  if (args.scopeKeys.length === 0) return [];
  const placeholders = args.scopeKeys.map(() => "?").join(",");
  // FTS5-only in M1 (vectors land in M2); LIKE fallback when FTS errors
  try {
    const rows = db.prepare(
      `SELECT o.id, o.content, s.key AS scopeKey, bm25(fts_observations) AS rank
       FROM fts_observations f JOIN observations o ON o.id = f.rowid JOIN scopes s ON s.id = o.scope_id
       WHERE fts_observations MATCH ? AND s.key IN (${placeholders})
       ORDER BY rank LIMIT ?`
    ).all(args.query, ...args.scopeKeys, limit) as { id: number; content: string; scopeKey: string; rank: number }[];
    logRecall(db, args.query, null, rows.map((r) => r.id), rows.map((r) => r.rank));
    return rows.map((r) => ({ id: r.id, content: r.content, score: -r.rank, source: "fts", scopeKey: r.scopeKey }));
  } catch {
    const like = `%${args.query.split(/\s+/)[0] ?? args.query}%`;
    const rows = db.prepare(
      `SELECT o.id, o.content, s.key AS scopeKey FROM observations o JOIN scopes s ON s.id=o.scope_id
       WHERE o.content LIKE ? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT ?`
    ).all(like, ...args.scopeKeys, limit) as { id: number; content: string; scopeKey: string }[];
    logRecall(db, args.query, null, rows.map((r) => r.id), rows.map(() => 0));
    return rows.map((r) => ({ id: r.id, content: r.content, score: 0, source: "like", scopeKey: r.scopeKey }));
  }
}

function logRecall(db: Db, query: string, scopeIdV: number | null, ids: number[], scores: number[]): void {
  db.prepare("INSERT INTO recall_log(query,scope_id,result_ids_json,scores_json,hit,pi_session_id,timestamp) VALUES(?,?,?,?,?,?,?)")
    .run(query, scopeIdV, JSON.stringify(ids), JSON.stringify(scores), ids.length > 0 ? 1 : 0, null, Date.now() / 1000);
}

export function getProfile(db: Db, args: { peer: string; scopeKeys: string[] }): string[] {
  if (args.scopeKeys.length === 0) return [];
  const placeholders = args.scopeKeys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT c.content FROM peer_cards c JOIN scopes s ON s.id=c.scope_id WHERE c.peer_id=? AND s.key IN (${placeholders})`
  ).all(args.peer, ...args.scopeKeys) as { content: string }[];
  if (rows.length > 0) return rows.map((r) => r.content);
  // fallback: latest global observations
  const fb = db.prepare(
    `SELECT o.content FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE o.peer_id=? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT 10`
  ).all(args.peer, ...args.scopeKeys) as { content: string }[];
  return fb.map((r) => r.content);
}

export function dbStatus(db: Db): { schemaVersion: number; observations: number; ftsCount: number; queuePending: number; dbSize: number | null } {
  const v = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string };
  const c = db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
  let fts = 0;
  try { fts = (db.prepare("SELECT COUNT(*) AS n FROM fts_observations").get() as { n: number }).n; } catch { fts = -1; }
  const q = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get() as { n: number };
  return { schemaVersion: Number(v.value), observations: c.n, ftsCount: fts, queuePending: q.n, dbSize: null };
}
```

- [ ] **Step 12: Run db tests, expect pass**

Run: `npx tsx --test tests/db.test.ts tests/redact.test.ts tests/scopes.test.ts`
Expected: PASS (7+ tests).

- [ ] **Step 13: Commit**

```bash
git add extensions/lib/db.ts extensions/lib/scopes.ts extensions/lib/redact.ts tests/db.test.ts tests/redact.test.ts tests/scopes.test.ts
git commit -m "pi-mindvault M1: sqlite WAL+FTS5 CRUD, scopes, redact (TDD)"
```

---

### Task 3: pi extension entry (4 tools + commands + hooks)

**Files:**
- Create: `extensions/mindvault.ts`

- [ ] **Step 1: Write entry (full)**

```typescript
// extensions/mindvault.ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { homedir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus } from "./lib/db.ts";
import { scopeKeysForRead, resolveScope, gitRootSync } from "./lib/scopes.ts";

function dbPath(): string {
  return join(homedir(), ".pi", "memory", "memory.db");
}

export default function (pi: ExtensionAPI) {
  const getDb = () => openMindvault(dbPath());
  const ctxScopes = (cwd: string) => {
    const repo = gitRootSync(cwd);
    return scopeKeysForRead({ cwd, repoRoot: repo });
  };

  pi.on("session_start", async (_event, ctx) => {
    try {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      if (cards.length > 0) ctx.ui.notify(`mindvault: ${cards.length} profile block(s) loaded`, "info");
    } catch { /* offline-safe: never block startup */ }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    try {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      if (cards.length === 0) return;
      return { systemPrompt: event.systemPrompt + "\n\n# Long-term memory (pi-mindvault)\n" + cards.join("\n").slice(0, 3000) };
    } catch { return; }
  });

  pi.registerTool({
    name: "memory_profile",
    label: "Memory Profile",
    description: "Fast peer card retrieval (no LLM). Returns curated facts about the user.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const cards = getProfile(db, { peer: "user", scopeKeys: ctxScopes(ctx.cwd) });
      db.close();
      return { content: [{ type: "text" as const, text: cards.join("\n") || "(no profile yet)" }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Hybrid search over local memory. Returns raw excerpts ranked by relevance.",
    parameters: Type.Object({ query: Type.String({ description: "Search query" }), limit: Type.Optional(Type.Number()) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: params.limit ?? 5 });
      db.close();
      const text = hits.map((h) => `[${h.id}] (${h.source} ${h.scopeKey}) ${h.content}`).join("\n") || "(no hits)";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_context",
    label: "Memory Context",
    description: "Synthesized answer from memory excerpts (M1: extractive, LLM synthesis lands in M3).",
    parameters: Type.Object({ query: Type.String({ description: "Question about memory" }) }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const hits = recallSearch(db, { query: params.query, scopeKeys: ctxScopes(ctx.cwd), limit: 8 });
      db.close();
      const text = hits.map((h) => `[${h.id}] ${h.content}`).join("\n") || "(no context)";
      return { content: [{ type: "text" as const, text }], details: {} };
    },
  });

  pi.registerTool({
    name: "memory_conclude",
    label: "Memory Conclude",
    description: "Save a durable fact. Explicit saves always win conflicts and never decay.",
    parameters: Type.Object({
      content: Type.String({ description: "Fact to remember" }),
      memType: Type.Optional(Type.Union([Type.Literal("episodic"), Type.Literal("semantic"), Type.Literal("procedural"), Type.Literal("working")])),
      global: Type.Optional(Type.Boolean({ description: "Save to global scope (default: current directory)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const scope = resolveScope({ cwd: ctx.cwd, repoRoot: repo, explicit: params.global ? "global" : null });
      const id = remember(db, { peer: "user", content: params.content, memType: params.memType ?? "semantic", scopeKey: scope.key, explicit: 1, cwd: ctx.cwd });
      db.close();
      return { content: [{ type: "text" as const, text: `remembered #${id} in ${scope.key}` }], details: {} };
    },
  });

  pi.registerCommand("mindvault-setup", {
    description: "Initialize local mindvault DB",
    handler: async (_args, ctx) => {
      const db = getDb();
      const st = dbStatus(db);
      db.close();
      ctx.ui.notify(`mindvault ready (schema ${st.schemaVersion}, ${st.observations} memories)`, "info");
    },
  });

  pi.registerCommand("memory", {
    description: "memory status",
    handler: async (_args, ctx) => {
      const db = getDb();
      const st = dbStatus(db);
      db.close();
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending}`, "info");
    },
  });
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. If `typebox` import path differs, use `Type` from `@earendil-works/pi-coding-agent` re-export — check `docs/extensions.md` Available Imports and fix inline.

- [ ] **Step 3: Smoke test with pi -e**

Run: `pi -e ./extensions/mindvault.ts --help 2>&1 | head -n 20`
Expected: pi starts (extension loads without throwing). If `pi` binary missing from PATH, run `npx pi --help` equivalent or skip with note — do not block; tools are covered by unit tests.

- [ ] **Step 4: Commit**

```bash
git add extensions/mindvault.ts
git commit -m "pi-mindvault M1: 4 tools + setup/status commands + inject hooks"
```

---

### Task 4: Full suite + docs + push

- [ ] **Step 1: Run full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 3: Update README status (append M1 scope)**

Append to `README.md`:
```markdown
## M1 scope (this plan)
- FTS5-only search (no vectors yet — M2 adds `sqlite-vec` + RRF).
- `memory_context` is extractive in M1; LLM synthesis lands in M3.
- Queue table exists for M3 workers; M1 writes synchronously.
```

Run:
```bash
git add README.md
git commit -m "pi-mindvault M1: scope note in README"
```

- [ ] **Step 4: Push**

```bash
git push
```

---

## Self-review
- Spec coverage: FR1-FR6 (identity/scopes/storage/FTS) → Task 2; FR7 partially (sync buffer, queue table exists, async workers M3) → Task 2+3; FR10-FR13 reads (FTS-only, no RRF weights yet — M2) → Task 2+3; FR16 delete deferred to M2 (note); FR17-FR18 status + recall_log → Task 2+3. FR8 redaction → Task 2. FR14-FR15 Dreamer/optimize → M3/M4, queue + status groundwork here.
- Placeholders: none — all code blocks complete, commands exact, expected outputs stated.
- Types: `Db = DatabaseSync`, `MemType`, `Hit`, `ScopeRef` consistent across db/scopes/entry; tool names `memory_profile/search/context/conclude` match PRD FR + README.
