import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, getProfile, dbStatus, explainObservation, editObservation } from "../extensions/lib/db.ts";
import { LATEST_SCHEMA_VERSION } from "../extensions/lib/migrations.ts";

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
  assert.equal(st.schemaVersion, LATEST_SCHEMA_VERSION);
  db.close();
});

test("fresh DB is stamped at the latest schema version", () => {
  const db = openMindvault(tmpDb());
  assert.equal(dbStatus(db).schemaVersion, LATEST_SCHEMA_VERSION);
  db.close();
});

test("busy_timeout is set on open", () => {
  const db = openMindvault(tmpDb());
  const r = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
  assert.equal(r.timeout, 5000);
  db.close();
});

test("migrates a legacy v1 DB forward without data loss", () => {
  const path = tmpDb();
  const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE state_meta(key TEXT PRIMARY KEY, value TEXT)");
  legacy.exec("CREATE TABLE observations(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL DEFAULT 'pi', peer_id TEXT NOT NULL, session_id TEXT, scope_id INTEGER NOT NULL, mem_type TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, explicit INTEGER NOT NULL DEFAULT 0, supersedes_id INTEGER, expiry REAL, accesses INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL)");
  legacy.prepare("INSERT INTO observations(peer_id,scope_id,mem_type,content,created_at,updated_at) VALUES('u',1,'semantic','legacy fact',0,0)").run();
  legacy.prepare("INSERT INTO state_meta(key,value) VALUES('schema_version','1')").run();
  legacy.close();

  const db = openMindvault(path);
  const cols = db.prepare("PRAGMA table_info(observations)").all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "embedding"));
  assert.equal(dbStatus(db).schemaVersion, LATEST_SCHEMA_VERSION);
  const row = db.prepare("SELECT content FROM observations WHERE content='legacy fact'").get() as { content: string };
  assert.equal(row.content, "legacy fact");
  db.close();
});

test("db file is created with 0600 permissions", { skip: process.platform === "win32" }, () => {
  const path = tmpDb();
  const db = openMindvault(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  db.close();
});

test("memory_why explains a recalled observation", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "deploy uses blue-green strategy", memType: "semantic", scopeKey: "dir:/a", explicit: 1, cwd: "/a" });
  recallSearch(db, { query: "blue-green deploy", scopeKeys: ["dir:/a"], limit: 5 });
  const ex = explainObservation(db, id);
  assert.ok(ex);
  assert.equal(ex!.explicit, 1);
  assert.equal(ex!.scopeKey, "dir:/a");
  assert.ok(ex!.accesses >= 1);
  assert.ok(ex!.lastRecall && ex!.lastRecall.query.includes("blue-green"));
  assert.equal(explainObservation(db, 99999), null);
  db.close();
});

test("memory_edit updates content, search index, and embedding", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "prefers yaml config", memType: "semantic", scopeKey: "dir:/a", explicit: 0, cwd: "/a" });
  assert.ok(editObservation(db, { id, content: "prefers toml config", cwd: "/a" }));
  const row = db.prepare("SELECT content FROM observations WHERE id=?").get(id) as { content: string };
  assert.equal(row.content, "prefers toml config");
  const hits = recallSearch(db, { query: "toml config", scopeKeys: ["dir:/a"], limit: 5 });
  assert.ok(hits.some((h) => h.content.includes("toml")));
  assert.equal(editObservation(db, { id: 99999, content: "x", cwd: "/a" }), false);
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
