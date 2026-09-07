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

test("auto-capture redacts secrets before storing raw text", () => {
  const db = openMindvault(tmpDb());
  const secret = "sk-abc123deadbeef456";
  const gh = "ghp_deadbeef12345678";
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIBVgIBADANBg\n-----END PRIVATE KEY-----";
  ingestMessage(db, {
    sessionId: "s1",
    peer: "u",
    role: "user",
    content: `Here is my key ${secret} and token ${gh}. Also the block ${pem} should never persist.`,
    cwd: "/a",
  });
  const raw = db.prepare("SELECT content FROM messages WHERE session_id='s1'").get() as { content: string };
  assert.ok(!raw.content.includes(secret));
  assert.ok(!raw.content.includes(gh));
  assert.ok(!raw.content.includes("MIIBVgIBADANBg"));
  assert.ok(raw.content.includes("[redacted]"));
  drainQueue(db, { limit: 10 });
  const obs = db.prepare("SELECT content FROM observations").all() as { content: string }[];
  for (const o of obs) {
    assert.ok(!o.content.includes(secret));
    assert.ok(!o.content.includes(gh));
    assert.ok(!o.content.includes("MIIBVgIBADANBg"));
  }
  db.close();
});

test("a multi-sentence decision stays in one observation", () => {
  const db = openMindvault(tmpDb());
  ingestMessage(db, { sessionId: "s1", peer: "u", role: "user", content: "We decided to adopt Postgres as the primary datastore. This choice keeps transactions ACID compliant.", cwd: "/a" });
  drainQueue(db, { limit: 10 });
  const obs = db.prepare("SELECT content FROM observations").all() as { content: string }[];
  assert.equal(obs.length, 1);
  assert.ok(obs[0].content.includes("Postgres") && obs[0].content.includes("ACID"));
  db.close();
});

test("a code fence survives as an observation beyond 200 chars", () => {
  const db = openMindvault(tmpDb());
  const code = "```js\n" + "const x = 1; // config line\n".repeat(12) + "```";
  ingestMessage(db, { sessionId: "s1", peer: "u", role: "user", content: `Here is the setup.\n${code}\nThat is all.`, cwd: "/a" });
  drainQueue(db, { limit: 10 });
  const obs = db.prepare("SELECT content FROM observations").all() as { content: string }[];
  assert.ok(obs.some((o) => o.content.includes("```") && o.content.length > 200));
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
