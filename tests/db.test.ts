import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
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

test("db file is created with 0600 permissions", { skip: process.platform === "win32" }, () => {
  const path = tmpDb();
  const db = openMindvault(path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
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
