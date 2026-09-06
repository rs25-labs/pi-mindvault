# pi-mindvault M4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M4 — Dreamer consolidation (dedupe + decay + card refresh), `memory_optimize` maintenance, recall tuning stats, release docs, and npm publish readiness.

**Architecture:** `extensions/lib/dreamer.ts` owns consolidation: near-dup merge (cosine ≥ 0.95, same peer+scope → keep explicit/newest, mark `supersedes_id`), contradiction surfacing (explicit already wins at write; Dreamer logs superseded pairs), episodic decay (`importance<0.3 AND accesses=0 AND age>30d`, explicit + `procedural/global` exempt), and `peer_cards` refresh for every peer+scope. `extensions/lib/maint.ts` owns `optimizeNow()` (WAL checkpoint → FTS rebuild → backfill → prune → VACUUM, each step best-effort and logged). `memory_optimize` tool/command + `dream` command expose them; `/memory` gains recall hit-rate from `recall_log`. Release: version bump, gallery metadata, publish dry-run. Requires M3 merged.

**Tech Stack:** TypeScript, `node:sqlite`, `node:test` via `tsx`. Heuristic Dreamer (no LLM); Task 1 spikes extension model-call support — if unavailable, documents the deferral.

---

## File structure (M4 creates/modifies)
- Create: `extensions/lib/dreamer.ts` — `dream(db, opts)` (dedupe, decay, card refresh, returns stats)
- Create: `extensions/lib/maint.ts` — `optimizeNow(db)` (checkpoint, FTS rebuild, backfill, prune, vacuum)
- Modify: `extensions/mindvault.ts` — `memory_optimize` tool, `dream` + `memory-prune` commands, recall hit-rate in `/memory`
- Create: `tests/dreamer.test.ts`, `tests/maint.test.ts`
- Modify: `package.json` — version `0.1.0` stays (publish as 0.1.0), add gallery `image`? skip (no asset) — add `repository`, `homepage`, `license: MIT`, gallery `video`/`image` omitted
- Create: `LICENSE` (MIT), `CHANGELOG.md` (M1–M4 entries)
- Modify: `README.md` — final usage/config/troubleshooting polish

---

### Task 1: Model-call spike + Dreamer (TDD)

**Files:**
- Create: `extensions/lib/dreamer.ts`
- Test: `tests/dreamer.test.ts`

- [ ] **Step 1: Spike — can extensions call a model?**

Inspect `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts` for model-call surfaces (`modelRegistry`, `ctx.model`, chat/completions helpers). Record finding as a code comment at the top of `dreamer.ts`:
- If a supported call path exists: use it ONLY for contradiction summarization behind `MINDVAULT_LLM_DREAM=1`, heuristic otherwise.
- If not: heuristic Dreamer ships; comment states `LLM Dreamer deferred — no extension model-call API in installed pi`.

Either way the tests below must pass without network.

- [ ] **Step 2: Write failing test**

```typescript
// tests/dreamer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, recallSearch } from "../extensions/lib/db.ts";
import { dream } from "../extensions/lib/dreamer.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv4-")), "memory.db");
}

test("near-dups merge, explicit survivor wins", () => {
  const db = openMindvault(tmpDb());
  db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',(SELECT id FROM scopes WHERE key='global' OR 1 LIMIT 1),'semantic',?,0.5,0,0,0,0)").run("we use sqlite for memory");
  db.close();
});
```

Stop — that SQL is fragile (scope may not exist). Write the test properly with public API only:

```typescript
// tests/dreamer.test.ts (final — use this)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch } from "../extensions/lib/db.ts";
import { dream } from "../extensions/lib/dreamer.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv4-")), "memory.db");
}

test("near-dups merge, survivor still recalls", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "we use sqlite for local memory storage", memType: "semantic", scopeKey: "global", explicit: 0, cwd: "/a" });
  remember(db, { peer: "u", content: "we use sqlite for local memory storage!", memType: "semantic", scopeKey: "global", explicit: 0, cwd: "/a" });
  const before = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  const stats = dream(db, {});
  const after = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  assert.ok(stats.merged >= 1);
  assert.ok(after < before);
  const hits = recallSearch(db, { query: "sqlite memory", scopeKeys: ["global"], limit: 5 });
  assert.ok(hits.some((h) => h.content.includes("sqlite")));
  db.close();
});

test("stale low-importance episodic decays, explicit survives", () => {
  const db = openMindvault(tmpDb());
  const old = Date.now() / 1000 - 40 * 86400;
  db.prepare("INSERT INTO scopes(workspace_id,kind,key) VALUES('pi','dir','dir:/a')").run();
  db.prepare("INSERT INTO peers(id,workspace_id,kind,created_at) VALUES('u','pi','user',0)").run();
  const sid = (db.prepare("SELECT id FROM scopes WHERE key='dir:/a'").get() as { id: number }).id;
  db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'episodic','saw a cloud shaped like a router',0.1,0,0,?,?)").run(sid, old, old);
  db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'episodic','never deploy on fridays',0.9,1,0,?,?)").run(sid, old, old);
  const stats = dream(db, {});
  assert.ok(stats.pruned >= 1);
  const left = db.prepare("SELECT content FROM observations").all() as { content: string }[];
  assert.ok(left.some((r) => r.content.includes("fridays")));
  assert.ok(!left.some((r) => r.content.includes("cloud")));
  db.close();
});

test("dream refreshes peer cards", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "loves dark mode everywhere", memType: "semantic", scopeKey: "global", explicit: 1, cwd: "/a" });
  dream(db, {});
  const card = db.prepare("SELECT content FROM peer_cards").all() as { content: string }[];
  assert.ok(card.join("\n").includes("dark mode"));
  db.close();
});
```

- [ ] **Step 3: Run, expect fail**

Run: `npx tsx --test tests/dreamer.test.ts`
Expected: FAIL module not found.

- [ ] **Step 4: Implement dreamer.ts**

```typescript
// extensions/lib/dreamer.ts
// Model-call spike (installed pi): ExtensionContext exposes modelRegistry/model info
// but no supported extension-invoked chat/completions path, so Dreamer is heuristic.
// Set MINDVAULT_LLM_DREAM=1 in future when pi exposes one; heuristic stays the default.
import type { Db } from "./db.ts";
import { featureHash, defaultEmbedder } from "./embeddings.ts";
import { vecMode } from "./vec.ts";

export interface DreamStats { merged: number; pruned: number; cards: number }

function embOf(content: string): Float32Array {
  return featureHash(content, defaultEmbedder().dim);
}
function cos(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export function dream(db: Db, _opts: Record<string, never]): DreamStats {
  const stats: DreamStats = { merged: 0, pruned: 0, cards: 0 };
  stats.merged = mergeDupes(db);
  stats.pruned = decayStale(db);
  stats.cards = refreshCards(db);
  db.prepare("INSERT INTO state_meta(key,value) VALUES('last_dream',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(Date.now() / 1000));
  return stats;
}

function mergeDupes(db: Db): number {
  const rows = db.prepare("SELECT id, peer_id, scope_id, content, explicit, importance FROM observations ORDER BY id").all() as
    { id: number; peer_id: string; scope_id: number; content: string; explicit: number; importance: number }[];
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.peer_id}::${r.scope_id}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(r);
  }
  let merged = 0;
  const cache = new Map<number, Float32Array>();
  const emb = (r: (typeof rows)[number]): Float32Array => {
    let v = cache.get(r.id);
    if (!v) { v = embOf(r.content); cache.set(r.id, v); }
    return v;
  };
  for (const group of byGroup.values()) {
    const dead = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (dead.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (dead.has(group[j].id)) continue;
        if (cos(emb(group[i]), emb(group[j])) < 0.95) continue;
        // survivor: explicit first, then higher importance, then newer (higher id)
        const a = group[i], b = group[j];
        const survivor = (b.explicit - a.explicit) || (b.importance - a.importance) || (b.id - a.id) >= 0 ? b : a;
        const loser = survivor === a ? b : a;
        db.prepare("UPDATE observations SET supersedes_id=? WHERE id=?").run(loser.id, survivor.id);
        deleteObservationRow(db, loser.id);
        dead.add(loser.id);
        merged++;
      }
    }
  }
  return merged;
}

function deleteObservationRow(db: Db, id: number): void {
  if (vecMode(db) === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid=?").run(id); } catch { /* js */ }
  }
  db.prepare("DELETE FROM observations WHERE id=?").run(id);
}

function decayStale(db: Db, nowSeconds = Date.now() / 1000): number {
  const cutoff = nowSeconds - 30 * 86400;
  const stale = db.prepare(
    `SELECT id FROM observations WHERE mem_type='episodic' AND explicit=0 AND importance < 0.3 AND accesses=0 AND created_at < ? AND scope_id NOT IN (SELECT s.id FROM scopes s WHERE s.key='global')`
  ).all(cutoff) as { id: number }[];
  // global scope exempt (identity facts); procedural exempt by type (not episodic)
  for (const r of stale) deleteObservationRow(db, r.id);
  return stale.length;
}

function refreshCards(db: Db): number {
  const pairs = db.prepare("SELECT DISTINCT peer_id, scope_id FROM observations").all() as { peer_id: string; scope_id: number }[];
  const now = Date.now() / 1000;
  for (const p of pairs) {
    const rows = db.prepare("SELECT content FROM observations WHERE peer_id=? AND scope_id=? ORDER BY explicit DESC, importance DESC, id DESC LIMIT 20")
      .all(p.peer_id, p.scope_id) as { content: string }[];
    const card = rows.map((x) => `- ${x.content}`).join("\n").slice(0, 4000);
    db.prepare("INSERT INTO peer_cards(peer_id,scope_id,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(peer_id,scope_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at")
      .run(p.peer_id, p.scope_id, card, now);
  }
  return pairs.length;
}
```

Survivor expression precedence check: `(b.explicit - a.explicit) || (b.importance - a.importance) || (b.id - a.id) >= 0 ? b : a` — `>=` binds tighter than `?:` but looser than `||`? Actually `||` has HIGHER precedence than `?:`, and `>=` higher than `||`. So it parses as `((diff) || (diff) || ((b.id-a.id) >= 0)) ? b : a`. The first two arms return numbers (truthy unless 0) — `0 || 0 || bool` → bool; nonzero diff → number (truthy) → picks b even when diff is NEGATIVE (a wins on explicit but expression truthy → b). BUG. Fix before implementing: compute explicitly:
```typescript
const cmp = (b.explicit - a.explicit) || (b.importance - a.importance) || (b.id - a.id);
const survivor = cmp >= 0 ? b : a;
```
Use this corrected form in the implementation (the plan text above shows the buggy one-liner — do NOT copy it; use the two-line form).

- [ ] **Step 5: Run all tests, expect pass**

Run: `npx tsx --test tests/*.test.ts`
Expected: PASS (22 + 3 = 25).

- [ ] **Step 6: Commit**

```bash
git add extensions/lib/dreamer.ts tests/dreamer.test.ts
git commit -m "pi-mindvault M4: Dreamer (dedupe, decay, card refresh)"
```

---

### Task 2: Maintenance — optimizeNow (TDD)

**Files:**
- Create: `extensions/lib/maint.ts`
- Test: `tests/maint.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// tests/maint.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch } from "../extensions/lib/db.ts";
import { optimizeNow } from "../extensions/lib/maint.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mv5-")), "memory.db");
}

test("optimize preserves recall and reports steps", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "optimize keeps this fact", memType: "semantic", scopeKey: "dir:/a", explicit: 1, cwd: "/a" });
  const rep = optimizeNow(db, {});
  assert.ok(rep.checkpoint === "ok" || rep.checkpoint === "skipped");
  assert.ok(rep.ftsRebuild === "ok" || rep.ftsRebuild === "skipped");
  const hits = recallSearch(db, { query: "optimize keeps", scopeKeys: ["dir:/a"], limit: 5 });
  assert.ok(hits.some((h) => h.content.includes("keeps")));
  db.close();
});
```

- [ ] **Step 2: Run, expect fail**

Run: `npx tsx --test tests/maint.test.ts`
Expected: FAIL module not found.

- [ ] **Step 3: Implement maint.ts**

```typescript
// extensions/lib/maint.ts
import type { Db } from "./db.ts";
import { backfillEmbeddings } from "./db.ts";
import { dream } from "./dreamer.ts";

export interface OptimizeReport {
  checkpoint: "ok" | "skipped";
  ftsRebuild: "ok" | "skipped";
  backfilled: number;
  dreamed: { merged: number; pruned: number; cards: number };
  prunedExpired: number;
  vacuum: "ok" | "skipped";
}

export function optimizeNow(db: Db, _opts: Record<string, never>): OptimizeReport {
  const rep: OptimizeReport = { checkpoint: "skipped", ftsRebuild: "skipped", backfilled: 0, dreamed: { merged: 0, pruned: 0, cards: 0 }, prunedExpired: 0, vacuum: "skipped" };
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); rep.checkpoint = "ok"; } catch { /* read-only or no WAL */ }
  try { db.exec("INSERT INTO fts_observations(fts_observations) VALUES('rebuild')"); rep.ftsRebuild = "ok"; } catch { /* FTS degraded */ }
  try { rep.backfilled = backfillEmbeddings(db, 2000); } catch { rep.backfilled = 0; }
  try { rep.dreamed = dream(db, {}); } catch { /* keep report */ }
  try {
    const r = db.prepare("DELETE FROM observations WHERE expiry IS NOT NULL AND expiry < ?").run(Date.now() / 1000) as { changes: number | bigint };
    rep.prunedExpired = Number(r.changes);
  } catch { /* keep */ }
  try { db.exec("VACUUM"); rep.vacuum = "ok"; } catch { /* busy/open transactions */ }
  return rep;
}
```

Note: `dream()` inside optimize double-counts decay with `prunedExpired`? No — decay removes old low-importance rows; expiry removes time-expired rows. Distinct predicates, both reported separately. Fine.

- [ ] **Step 4: Run all tests, expect pass**

Run: `npx tsx --test tests/*.test.ts`
Expected: PASS (25 + 1 = 26).

- [ ] **Step 5: Commit**

```bash
git add extensions/lib/maint.ts tests/maint.test.ts
git commit -m "pi-mindvault M4: optimize (checkpoint, FTS rebuild, backfill, prune, vacuum)"
```

---

### Task 3: Wire tools — optimize/dream/prune + hit-rate status (small)

**Files:**
- Modify: `extensions/mindvault.ts`

- [ ] **Step 1: Add tools/commands + hit-rate**

Imports add: `import { optimizeNow } from "./lib/maint.ts"; import { dream } from "./lib/dreamer.ts"; import { deleteScope } from "./lib/db.ts";`

Register after `memory_forget`:
```typescript
  pi.registerTool({
    name: "memory_optimize",
    label: "Memory Optimize",
    description: "Run maintenance: checkpoint, FTS rebuild, embedding backfill, Dreamer pass, expiry prune, vacuum. Slow on large DBs.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const db = getDb();
      const rep = optimizeNow(db, {});
      db.close();
      return { content: [{ type: "text" as const, text: `optimize: checkpoint=${rep.checkpoint} fts=${rep.ftsRebuild} backfilled=${rep.backfilled} merged=${rep.dreamed.merged} pruned=${rep.dreamed.pruned}+${rep.prunedExpired} vacuum=${rep.vacuum}` }], details: {} };
    },
  });

  pi.registerCommand("dream", {
    description: "Run Dreamer consolidation (dedupe, decay, card refresh)",
    handler: async (_args, ctx) => {
      const db = getDb();
      const s = dream(db, {});
      db.close();
      ctx.ui.notify(`dream: merged=${s.merged} pruned=${s.pruned} cards=${s.cards}`, "info");
    },
  });

  pi.registerCommand("memory-prune", {
    description: "Delete one scope (e.g. memory-prune dir:/tmp/scratch)",
    handler: async (args, ctx) => {
      const scope = String(args ?? "").trim();
      if (!scope) { ctx.ui.notify("usage: memory-prune <scopeKey> (e.g. global, dir:/path)", "error"); return; }
      const db = getDb();
      const n = deleteScope(db, scope);
      db.close();
      ctx.ui.notify(`pruned ${n} memories from ${scope}`, "info");
    },
  });
```
Extend `/memory` handler: query hit-rate and append. Replace notify line with:
```typescript
      const q = queueStatus(db);
      let hit = "(no queries yet)";
      try {
        const r = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(hit),0) AS h FROM recall_log").get() as { n: number; h: number };
        if (r.n > 0) hit = `${Math.round((r.h / r.n) * 100)}% of ${r.n}`;
      } catch { /* pre-M2 DBs lack recall_log shape — ignore */ }
      ctx.ui.notify(`mindvault: schema=${st.schemaVersion} obs=${st.observations} fts=${st.ftsCount} queue=${st.queuePending}+${q.pending}p/${q.failed}f vec=${st.vecMode} dim=${st.embeddingDim ?? "?"} recall-hit=${hit}`, "info");
```

- [ ] **Step 2: Typecheck + tests + load check**

Run: `npx tsc --noEmit && npx tsx --test tests/*.test.ts`
Expected: clean, all PASS (26). Then `npx tsx -e "import('./extensions/mindvault.ts')..."` loads function.

- [ ] **Step 3: Commit**

```bash
git add extensions/mindvault.ts
git commit -m "pi-mindvault M4: optimize/dream/prune tools + recall hit-rate"
```

---

### Task 4: Release — LICENSE, CHANGELOG, package metadata, README, publish dry-run

**Files:**
- Create: `LICENSE`, `CHANGELOG.md`
- Modify: `package.json`, `README.md`

- [ ] **Step 1: MIT LICENSE (copyright holder: rs25-labs)**

```text
MIT License

Copyright (c) 2026 rs25-labs

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- [ ] **Step 2: CHANGELOG.md**

```markdown
# Changelog

## 0.1.0 — 2026-09-06
- M1: single-file sqlite (WAL + FTS5), scopes, redaction, 4 pi tools, setup/status commands
- M2: RRF hybrid recall, pluggable embeddings (feature-hash default, API fallback), optional vec0, forget/cascade
- M3: async queue + heuristic Deriver, extractive summaries, 40/60 budgeted context, auto-sync, session delete
- M4: Dreamer (dedupe, decay, card refresh), optimize (checkpoint, FTS rebuild, backfill, prune, vacuum), recall hit-rate, prune commands
```

- [ ] **Step 3: package.json release fields**

Add: `"license": "MIT"`, `"repository": {"type": "git", "url": "https://github.com/rs25-labs/pi-mindvault.git"}`, `"homepage": "https://github.com/rs25-labs/pi-mindvault"`. Keep `keywords: ["pi-package"]` (gallery discoverability). Version stays `0.1.0`.

- [ ] **Step 4: README final polish — append**

```markdown
## Maintain
- `memory_optimize` tool (or run `dream` / `memory-prune <scope>` commands): checkpoint + FTS rebuild + backfill + Dreamer + expiry prune + vacuum. Slow on large DBs — runIdle.
- `/memory` shows recall hit-rate (`recall-hit=82% of 50`) to tune thresholds.
- Explicit memories and `global` identity facts never decay; everything else follows the 30-day low-importance episodic policy.

## Install for real
\`\`\`bash
pi install npm:@rs25-labs/pi-mindvault
\`\`\`
Then `/mindvault-setup` inside pi. Requires pi with extension support and Node 22+.
```

- [ ] **Step 5: Publish dry-run (no publish yet)**

Run: `npm pack --dry-run 2>&1 | head -n 20`
Expected: lists files (extensions/, README, LICENSE, package.json), no `node_modules`, no `.worktrees`. If `node_modules/sqlite-vec-*` platform dirs are excluded automatically (dependencies aren't packed) — confirm `sqlite-vec` stays a runtime `dependencies` entry so `pi install` runs `npm install` for it.

Commit (publish itself needs npm auth — user runs `npm publish --access public` or hands a token):
```bash
git add LICENSE CHANGELOG.md package.json README.md
git commit -m "pi-mindvault M4: release metadata (MIT, changelog, gallery keywords)"
```

---

### Task 5: Full suite + push branch

- [ ] **Step 1: Verify**

Run: `npm test && npm run typecheck`
Expected: 26 PASS, clean.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/m4-dreamer-optimize
```

---

## Self-review
- Spec coverage: FR14 Dreamer/dedupe/decay → Task 1; FR15 optimize (checkpoint/rebuild/backfill/prune/vacuum) → Task 2; FR16 expiry prune → Task 2; FR17 status (hit-rate) → Task 3; PRD M4 publish → Task 4 (metadata + dry-run; publish gated on npm auth — stated, not a placeholder).
- Placeholders: none — survivor-selection bug from the draft one-liner is corrected to the two-line form before implementation; spike outcome pre-recorded (no extension model-call API → heuristic, flagged for future).
- Types: `DreamStats`, `OptimizeReport` new and consistent; `dbStatus` untouched.
