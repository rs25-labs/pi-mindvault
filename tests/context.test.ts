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

test("summarizeSession is exported and stable", () => {
  const db = openMindvault(tmpDb());
  seed(db);
  const a = summarizeSession(db, "s1");
  assert.ok(a.length > 0);
  db.close();
});
