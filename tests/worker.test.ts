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
