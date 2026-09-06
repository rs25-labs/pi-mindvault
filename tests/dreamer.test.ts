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

test("recalled memory survives decay (accesses protects it)", () => {
  const db = openMindvault(tmpDb());
  const old = Date.now() / 1000 - 40 * 86400;
  db.prepare("INSERT INTO scopes(workspace_id,kind,key) VALUES('pi','dir','dir:/a')").run();
  db.prepare("INSERT INTO peers(id,workspace_id,kind,created_at) VALUES('u','pi','user',0)").run();
  const sid = (db.prepare("SELECT id FROM scopes WHERE key='dir:/a'").get() as { id: number }).id;
  db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'episodic','stale unused note',0.1,0,0,?,?)").run(sid, old, old);
  db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'episodic','stale but recalled note',0.1,0,3,?,?)").run(sid, old, old);
  dream(db, {});
  const left = db.prepare("SELECT content FROM observations").all() as { content: string }[];
  assert.ok(left.some((r) => r.content.includes("recalled")));
  assert.ok(!left.some((r) => r.content.includes("unused")));
  db.close();
});

test("size cap evicts lowest-value rows but never explicit or global", () => {
  process.env.MINDVAULT_MAX_OBS = "3";
  const db = openMindvault(tmpDb());
  try {
    db.prepare("INSERT INTO scopes(workspace_id,kind,key) VALUES('pi','dir','dir:/a')").run();
    db.prepare("INSERT INTO scopes(workspace_id,kind,key) VALUES('pi','global','global')").run();
    db.prepare("INSERT INTO peers(id,workspace_id,kind,created_at) VALUES('u','pi','user',0)").run();
    const dir = (db.prepare("SELECT id FROM scopes WHERE key='dir:/a'").get() as { id: number }).id;
    const glob = (db.prepare("SELECT id FROM scopes WHERE key='global'").get() as { id: number }).id;
    const now = Date.now() / 1000;
    for (let i = 0; i < 10; i++) {
      db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'episodic',?,0.1,0,0,?,?)").run(dir, `zone${i} node${i} leaf${i}`, now, now);
    }
    db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'semantic','explicit keeper here',0.1,1,0,?,?)").run(dir, now, now);
    db.prepare("INSERT INTO observations(workspace_id,peer_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi','u',?,'semantic','global keeper here',0.1,0,0,?,?)").run(glob, now, now);
    dream(db, {});
    const left = db.prepare("SELECT content FROM observations").all() as { content: string }[];
    assert.ok(left.some((r) => r.content.includes("explicit keeper")));
    assert.ok(left.some((r) => r.content.includes("global keeper")));
    assert.ok(left.filter((r) => r.content.startsWith("zone")).length < 10);
  } finally {
    delete process.env.MINDVAULT_MAX_OBS;
    db.close();
  }
});

test("dream refreshes peer cards", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "loves dark mode everywhere", memType: "semantic", scopeKey: "global", explicit: 1, cwd: "/a" });
  dream(db, {});
  const card = db.prepare("SELECT content FROM peer_cards").all() as { content: string }[];
  assert.ok(card.map((c) => c.content).join("\n").includes("dark mode"));
  db.close();
});
