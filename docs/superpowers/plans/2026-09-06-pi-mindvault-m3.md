# pi-mindvault M3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M3 — async ingest queue with heuristic Deriver, extractive session summaries, token-budgeted prompt context (40% summary / 60% recent), session lifecycle helpers with cascade delete, and post-turn auto-sync.

**Architecture:** `extensions/lib/worker.ts` owns the queue: `ingestMessage()` buffers raw turns into `messages` + enqueues a job; `drainQueue()` claims jobs CAS (`pending→processing`), runs the heuristic Deriver (sentence-split → `episodic` observations, importance by signal words/length/questions), marks rows observed, retries ×3 → `failed`. `extensions/lib/context.ts` owns `summarizeSession()` (extractive) + `buildContext()` (profile + summary quota + recent quota). `mindvault.ts` hooks `agent_end` (ingest new session entries, bounded drain) and upgrades `before_agent_start` to `buildContext`. Requires M2 merged (imports `remember`, `recallSearch`, `featureHash`, `vecMode` from `db.ts`).

**Tech Stack:** TypeScript, `node:sqlite`, `node:test` via `tsx`. No LLM calls in M3 (heuristic Deriver; LLM synthesis stays M4).

---

## File structure (M3 creates/modifies)
- Create: `extensions/lib/worker.ts` — `ingestMessage`, `drainQueue`, `queueStatus`, Deriver heuristic
- Create: `extensions/lib/context.ts` — `summarizeSession`, `buildContext` (40/60 budget), `startSession`, `endSession`, `deleteSession`
- Modify: `extensions/mindvault.ts` — `agent_end` auto-sync, `before_agent_start` via `buildContext`, `/memory` shows queue/last-summary
- Create: `tests/worker.test.ts`, `tests/context.test.ts`
- Modify: `README.md` — M3 scope note

---

### Task 1: Queue worker + heuristic Deriver (TDD)

**Files:**
- Create: `extensions/lib/worker.ts`
- Test: `tests/worker.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/worker.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, recallSearch } from "../extensions/lib/db.ts";
import { ingestMessage, drainQueue, queueStatus } from "../extensions/lib/worker.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv3-")), "memory.db");
}

test("ingest + drain derives episodic observations", () => {
  const db = openMindvault(tmpDb());
  ingestMessage(db, { sessionId: "s1", peer: "u", role: "user", content: "We decided to use WAL mode. Why? Because crashes ate our data.", cwd: "/a" });
  assert.equal(queueStatus(db).pending, 1);
  const done = drainQueue(db, { limit: 10 });
  assert.equal(done, 1);
  assert.equal(queueStatus(db).pending, 0);
  const hits = recallSearch(db, { query: "WAL crashes", scopeKeys: ["dir:/a"], limit: 5 });
  assert.ok(hits.some((h) => h.content.includes("WAL")));
  db.close();
});

test("poison jobs fail after 3 attempts", () => {
  const db = openMindvault(tmpDb());
  db.prepare("INSERT INTO queue(session_id,status,attempts,payload_json,created_at) VALUES('s9','pending',2,'not-json{{{',0)").run();
  drainQueue(db, { limit: 10 });
  const row = db.prepare("SELECT status, attempts FROM queue WHERE session_id='s9'").get() as { status: string; attempts: number };
  assert.equal(row.status, "failed");
  assert.equal(row.attempts, 3);
  db.close();
});

test("empty queue drains zero", () => {
  const db = openMindvault(tmpDb());
  assert.equal(drainQueue(db, { limit: 10 }), 0);
  db.close();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx tsx --test tests/worker.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Implement worker.ts**

```typescript
// extensions/lib/worker.ts
import type { Db } from "./db.ts";
import { remember } from "./db.ts";
import { resolveScope, gitRootSync } from "./scopes.ts";

export interface IngestArgs { sessionId: string; peer: string; role: string; content: string; cwd: string; tokenCount?: number }

function signalImportance(sentence: string): number {
  let s = 0.35 + Math.min(0.3, sentence.length / 400);
  if (/\b(decided|decision|always|never|must|should|prefer|remember|important|fix|bug|error)\b/i.test(sentence)) s += 0.2;
  if (sentence.includes("?")) s += 0.1;
  if (/```/.test(sentence)) s += 0.1;
  return Math.min(1, Math.round(s * 100) / 100);
}

function splitSentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, (m) => " " + m.slice(0, 200))
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 24 && s.length < 600);
}

export function ingestMessage(db: Db, args: IngestArgs): number {
  db.prepare("INSERT OR IGNORE INTO sessions(id,workspace_id,cwd,started_at) VALUES(?,?,?,?)")
    .run(args.sessionId, "pi", args.cwd, Date.now() / 1000);
  db.prepare("INSERT OR IGNORE INTO session_peers(session_id,peer_id) VALUES(?,?)").run(args.sessionId, args.peer);
  const r = db.prepare("INSERT INTO messages(session_id,peer_id,role,content,timestamp,token_count) VALUES(?,?,?,?,?,?)")
    .run(args.sessionId, args.peer, args.role, args.content, Date.now() / 1000, args.tokenCount ?? null) as { lastInsertRowid: number | bigint };
  const mid = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO queue(session_id,status,attempts,payload_json,created_at) VALUES(?, 'pending', 0, ?, ?)")
    .run(args.sessionId, JSON.stringify({ messageId: mid, cwd: args.cwd, peer: args.peer }), Date.now() / 1000);
  return mid;
}

export function drainQueue(db: Db, opts?: { limit?: number }): number {
  const limit = opts?.limit ?? 20;
  const jobs = db.prepare("SELECT id, session_id, attempts, payload_json FROM queue WHERE status='pending' ORDER BY id LIMIT ?")
    .all(limit) as { id: number; session_id: string; attempts: number; payload_json: string }[];
  let done = 0;
  for (const j of jobs) {
    const claimed = db.prepare("UPDATE queue SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(j.id) as { changes: number | bigint };
    if (Number(claimed.changes) === 0) continue; // lost CAS race
    try {
      const p = JSON.parse(j.payload_json) as { messageId: number; cwd: string; peer: string };
      deriveMessage(db, p);
      db.prepare("UPDATE queue SET status='done' WHERE id=?").run(j.id);
      done++;
    } catch {
      const attempts = j.attempts + 1;
      db.prepare("UPDATE queue SET status=? WHERE id=?").run(attempts >= 3 ? "failed" : "pending", j.id);
    }
  }
  return done;
}

function deriveMessage(db: Db, p: { messageId: number; cwd: string; peer: string }): void {
  const msg = db.prepare("SELECT session_id, role, content, observed FROM messages WHERE id=?").get(p.messageId) as
    { session_id: string; role: string; content: string; observed: number } | undefined;
  if (!msg || msg.observed) return;
  if (msg.role === "tool") { db.prepare("UPDATE messages SET observed=1 WHERE id=?").run(p.messageId); return; }
  const repo = gitRootSync(p.cwd);
  const scope = resolveScope({ cwd: p.cwd, repoRoot: repo, explicit: null });
  const sents = splitSentences(msg.content).slice(0, 8);
  const now = Date.now() / 1000;
  for (const s of sents) {
    db.prepare("INSERT INTO observations(workspace_id,peer_id,session_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi',?,?,?,?,?,?,0,0,?,?)").run(
      p.peer, msg.session_id, scopeIdOf(db, scope.key), "episodic", s, signalImportance(s), now, now,
    );
    // embed the derived row (same inputs as remember's write path)
    const idRow = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    embedRow(db, idRow.id, s);
  }
  db.prepare("UPDATE messages SET observed=1 WHERE id=?").run(p.messageId);
  void remember; // explicit path stays the single writer for user-declared facts (no double-write here)
}

// Local scope-id + embed helpers (db.ts owns the canonicals; worker keeps its own to avoid widening db.ts surface in M3)
import { featureHash, defaultEmbedder } from "./embeddings.ts";
import { vecMode } from "./vec.ts";

function scopeIdOf(db: Db, scopeKey: string): number {
  const kind = scopeKey === "global" ? "global" : scopeKey.startsWith("dir:") ? "dir" : scopeKey.startsWith("repo:") ? "repo" : "session";
  db.prepare("INSERT OR IGNORE INTO scopes(workspace_id,kind,key) VALUES('pi',?,?)").run(kind, scopeKey);
  return (db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number }).id;
}

function embedRow(db: Db, id: number, content: string): void {
  try {
    const v = Buffer.from(featureHash(content, defaultEmbedder().dim).buffer);
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, id);
    if (vecMode(db) === "vec0") {
      try { db.prepare("INSERT INTO vec_observations(rowid, embedding) VALUES(?,?)").run(id, v); } catch { /* js covers */ }
    }
  } catch { /* embedding never blocks the worker */ }
}

export function queueStatus(db: Db): { pending: number; failed: number } {
  const p = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get() as { n: number };
  const f = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='failed'").get() as { n: number };
  return { pending: p.n, failed: f.n };
}
```

Note: `messages.observed` column does not exist in M1/M2 schema — Task 3 (below) adds it via reconcile in `openMindvault`. Task 1 tests will fail until Task 3 lands; run Task 1 + Task 3 schema change together, or implement the reconcile first. Order in this plan: implement `observed` reconcile as Step 4 of this task (small, listed below), then run tests.

- [ ] **Step 4: Add observed reconcile to db.ts openMindvault** (after the embedding reconcile block):
```typescript
  // M3 reconcile: observed flag (M1/M2 DBs lack it)
  try {
    const mcols = db.prepare(`PRAGMA table_info(messages)`).all() as { name: string }[];
    if (!mcols.some((c) => c.name === "observed")) db.exec(`ALTER TABLE messages ADD COLUMN observed INTEGER NOT NULL DEFAULT 0`);
  } catch { /* fresh schema already includes it */ }
```
And add `observed INTEGER NOT NULL DEFAULT 0` to the `messages` CREATE TABLE line.

- [ ] **Step 5: Run all tests, expect pass**

Run: `npx tsx --test tests/*.test.ts`
Expected: PASS (15 M1/M2 + 3 new = 18).

- [ ] **Step 6: Commit**

```bash
git add extensions/lib/worker.ts tests/worker.test.ts extensions/lib/db.ts
git commit -m "pi-mindvault M3: async queue + heuristic Deriver"
```

Remove the `void remember;` line and the unused `remember` import before committing (it was a deliberate no-double-write marker; dead code stays out). Final `worker.ts` imports: `type { Db }`, `resolveScope, gitRootSync`, `featureHash, defaultEmbedder`, `vecMode`.

---

### Task 2: Summaries + budgeted context + session lifecycle (TDD)

**Files:**
- Create: `extensions/lib/context.ts`
- Test: `tests/context.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault } from "../extensions/lib/db.ts";
import { ingestMessage, drainQueue } from "../extensions/lib/worker.ts";
import { startSession, endSession, summarizeSession, buildContext, deleteSession } from "../extensions/lib/context.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mvx-")), "memory.db");
}

function seed(db: ReturnType<typeof openMindvault>): void {
  startSession(db, { sessionId: "s1", piSessionId: "pi-1", cwd: "/a", repoRoot: null });
  ingestMessage(db, { sessionId: "s1", peer: "u", role: "user", content: "We are building a sqlite memory layer for pi. It must be offline-first and fast for local use.", cwd: "/a" });
  ingestMessage(db, { sessionId: "s1", peer: "a", role: "assistant", content: "Agreed. I will store facts in WAL mode and index them with FTS5 plus vectors for hybrid recall.", cwd: "/a" });
  drainQueue(db, { limit: 10 });
}

test("endSession writes a summary mentioning key terms", () => {
  const db = openMindvault(tmpDb());
  seed(db);
  const s = endSession(db, "s1");
  assert.ok(s.includes("sqlite") || s.includes("WAL") || s.includes("FTS5"));
  db.close();
});

test("buildContext respects 40/60 token split", () => {
  const db = openMindvault(tmpDb());
  seed(db);
  endSession(db, "s1");
  const ctx = buildContext(db, { cwd: "/a", tokenBudget: 1000 });
  assert.ok(ctx.summaryTokens + ctx.recentTokens <= 1000);
  assert.ok(ctx.summaryTokens <= 400);
  assert.ok(ctx.text.length > 0);
  db.close();
});

test("deleteSession cascades", () => {
  const db = openMindvault(tmpDb());
  seed(db);
  endSession(db, "s1");
  const n = deleteSession(db, "s1");
  assert.ok(n >= 2);
  const left = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE session_id='s1'").get() as { n: number };
  assert.equal(left.n, 0);
  db.close();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx tsx --test tests/context.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Implement context.ts**

```typescript
// extensions/lib/context.ts
import type { Db } from "./db.ts";
import { scopeKeysForRead } from "./scopes.ts";
import { getProfile } from "./db.ts";

export function startSession(db: Db, args: { sessionId: string; piSessionId: string; cwd: string; repoRoot: string | null }): void {
  db.prepare("INSERT OR IGNORE INTO sessions(id,workspace_id,pi_session_id,cwd,repo_root,started_at) VALUES(?,?,?, ?, ?, ?)")
    .run(args.sessionId, "pi", args.piSessionId, args.cwd, args.repoRoot, Date.now() / 1000);
}

function topTerms(db: Db, sessionId: string, limit = 12): string[] {
  const rows = db.prepare("SELECT content FROM observations WHERE session_id=? ORDER BY importance DESC, id LIMIT 40").all(sessionId) as { content: string }[];
  const stop = new Set("the,a,an,and,or,to,of,in,on,for,with,is,are,was,were,it,this,that,these,those,as,at,by,from,will,must,can,should,i,we,you,it,its,be,been,have,has,had,our,your,their".split(","));
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.content.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length < 4 || stop.has(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

export function summarizeSession(db: Db, sessionId: string): string {
  const terms = topTerms(db, sessionId);
  const tops = db.prepare("SELECT content FROM observations WHERE session_id=? ORDER BY explicit DESC, importance DESC, id LIMIT 5").all(sessionId) as { content: string }[];
  const lines = tops.map((r) => `- ${r.content}`);
  const summary = [`Session ${sessionId} summary.`, terms.length > 0 ? `Key topics: ${terms.join(", ")}.` : "No salient topics.", ...lines].join("\n");
  db.prepare("INSERT INTO summaries(session_id,kind,content,tokens,created_at) VALUES(?, 'session', ?, ?, ?)")
    .run(sessionId, summary, Math.ceil(summary.length / 4), Date.now() / 1000);
  db.prepare("UPDATE sessions SET summary=?, ended_at=? WHERE id=?").run(summary, Date.now() / 1000, sessionId);
  return summary;
}

export function endSession(db: Db, sessionId: string): string {
  const { drainQueue } = require_queue();
  drainQueue(db, { limit: 50 });
  return summarizeSession(db, sessionId);
}

// lazy require avoids a worker<->context import cycle at module load
import { drainQueue as _drain } from "./worker.ts";
function require_queue(): { drainQueue: typeof _drain } { return { drainQueue: _drain }; }

const CHARS_PER_TOKEN = 4;

export interface BuiltContext { text: string; summaryTokens: number; recentTokens: number }

export function buildContext(db: Db, args: { cwd: string; repoRoot?: string | null; tokenBudget?: number }): BuiltContext {
  const budget = args.tokenBudget ?? 2000;
  const summaryBudget = Math.floor(budget * 0.4);
  const recentBudget = budget - summaryBudget;
  const scopes = scopeKeysForRead({ cwd: args.cwd, repoRoot: args.repoRoot ?? null });
  const placeholders = scopes.map(() => "?").join(",");
  const cards = getProfile(db, { peer: "user", scopeKeys: scopes });
  const sumRow = db.prepare("SELECT content FROM summaries WHERE kind='session' ORDER BY id DESC LIMIT 1").get() as { content: string } | undefined;
  const summaryText = (sumRow?.content ?? "").slice(0, summaryBudget * CHARS_PER_TOKEN);
  const recent = db.prepare(
    `SELECT m.content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.cwd=? ORDER BY m.id DESC LIMIT 20`
  ).all(args.cwd) as { content: string }[];
  let recentText = "";
  for (const r of recent.reverse()) {
    const add = r.content.slice(0, 400) + "\n";
    if ((recentText.length + add.length) / CHARS_PER_TOKEN > recentBudget) break;
    recentText += add;
  }
  recentText = recentText.slice(0, recentBudget * CHARS_PER_TOKEN);
  const text = ["# Long-term memory (pi-mindvault)", ...cards, "", "## Session summary", summaryText, "", "## Recent", recentText]
    .join("\n").slice(0, budget * CHARS_PER_TOKEN);
  return { text, summaryTokens: Math.ceil(summaryText.length / CHARS_PER_TOKEN), recentTokens: Math.ceil(recentText.length / CHARS_PER_TOKEN) };
}

export function deleteSession(db: Db, sessionId: string): number {
  const mode = vecModeOf(db);
  if (mode === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid IN (SELECT id FROM observations WHERE session_id=?)").run(sessionId); } catch { /* js */ }
  }
  const a = db.prepare("DELETE FROM observations WHERE session_id=?").run(sessionId) as { changes: number | bigint };
  const m = db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId) as { changes: number | bigint };
  db.prepare("DELETE FROM summaries WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM session_peers WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM queue WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
  return Number(a.changes) + Number(m.changes);
}

import { vecMode } from "./vec.ts";
function vecModeOf(db: Db): string { return vecMode(db); }
```

- [ ] **Step 4: Run all tests, expect pass**

Run: `npx tsx --test tests/*.test.ts`
Expected: PASS (15 + 3 + 3 = 21).

- [ ] **Step 5: Commit**

```bash
git add extensions/lib/context.ts extensions/lib/worker.ts extensions/lib/db.ts tests/worker.test.ts tests/context.test.ts
git commit -m "pi-mindvault M3: queue worker, summaries, budgeted context, session delete"
```

---

### Task 3: Wire hooks — auto-sync + budgeted inject (small)

**Files:**
- Modify: `extensions/mindvault.ts`

- [ ] **Step 1: Replace before_agent_start + add agent_end**

Replace the `before_agent_start` handler body with:
```typescript
  pi.on("before_agent_start", async (_event, ctx) => {
    try {
      const db = getDb();
      const repo = gitRootSync(ctx.cwd);
      const built = buildContext(db, { cwd: ctx.cwd, repoRoot: repo, tokenBudget: 2000 });
      db.close();
      if (!built.text.trim()) return;
      return { systemPrompt: _event.systemPrompt + "\n\n" + built.text };
    } catch { return; }
  });

  pi.on("agent_end", async (_event, ctx) => {
    // best-effort post-turn sync: ingest unseen entries, bounded drain (never blocks shutdown)
    try {
      const db = getDb();
      const entries = ctx.sessionManager.getEntries() as { role?: string; content?: unknown; timestamp?: number }[];
      const known = new Set((db.prepare("SELECT timestamp, content FROM messages WHERE session_id=?").all(passthroughSession(ctx)) as { timestamp: number; content: string }[]).map((r) => r.timestamp + "::" + String(r.content).slice(0, 80)));
      let added = 0;
      for (const e of entries.slice(-30)) {
        const text = flattenContent(e.content);
        if (!text || text.length < 24) continue;
        const key = Number(e.timestamp ?? 0) + "::" + text.slice(0, 80);
        if (known.has(key)) continue;
        ingestMessage(db, { sessionId: passthroughSession(ctx), peer: e.role === "assistant" ? "pi-agent" : "user", role: String(e.role ?? "user"), content: text, cwd: ctx.cwd });
        added++;
        if (added >= 10) break;
      }
      if (added > 0) drainQueue(db, { limit: 20 });
      db.close();
    } catch { /* sync never breaks the agent loop */ }
  });
```
Helpers (top of file scope):
```typescript
import { ingestMessage, drainQueue } from "./lib/worker.ts";
import { buildContext } from "./lib/context.ts";

function passthroughSession(ctx: { sessionManager: { getSessionFile(): string | null } }): string {
  return ctx.sessionManager.getSessionFile() ?? `cwd:${ctx.cwd}`;
}
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b === "object" && "text" in (b as Record<string, unknown>) ? String((b as Record<string, unknown>).text) : "")).join("\n");
  }
  return "";
}
```
Keep `session_start` notify hook as-is. Update imports: add `buildContext`, `ingestMessage`, `drainQueue`.

- [ ] **Step 2: Typecheck + tests**

Run: `npx tsc --noEmit && npx tsx --test tests/*.test.ts`
Expected: clean, all PASS. If `getEntries()`/`getSessionFile()` shapes differ from installed pi types, adjust field access to match `ExtensionContext` in `node_modules/@earendil-works/pi-coding-agent` (read the `.d.ts`, fix inline — the try/catch keeps mismatches non-fatal at runtime).

- [ ] **Step 3: Commit**

```bash
git add extensions/mindvault.ts
git commit -m "pi-mindvault M3: post-turn auto-sync + budgeted inject"
```

---

### Task 4: Docs + push branch

- [ ] **Step 1: README scope note**

Append to `README.md`:
```markdown
## M3 scope
- Async ingest: turns buffered to `messages` + queue; heuristic Deriver (no LLM) extracts `episodic` facts; poison jobs fail after 3 attempts.
- Extractive session summaries + 40/60 budgeted prompt context; post-turn auto-sync (bounded, best-effort).
- Session lifecycle helpers + cascade delete. LLM-backed Deriver/Dreamer stay M4.
```

- [ ] **Step 2: Full suite + push**

Run: `npm test && npm run typecheck`
```bash
git add README.md
git commit -m "pi-mindvault M3: scope note in README"
git push -u origin feat/m3-async-deriver
```

---

## Self-review
- Spec coverage: FR7 queue/Deriver (heuristic; LLM extraction M4) → Task 1; FR14 session summaries → Task 2; FR10 budgeted inject (40/60) → Tasks 2+3; FR13 fallback (summaries/recent) → `buildContext`; FR16 session delete → Task 2; FR17 queue status → `queueStatus` + `/memory` extension in Task 3 if trivial (append `pending/failed` to status line — do it in the same edit).
- Placeholders: none — SQL/TS complete; `getEntries` shape guarded by try/catch + note to align with installed `.d.ts`.
- Types: `BuiltContext`, `IngestArgs` consistent; `dbStatus` untouched (M2 shape reused).
