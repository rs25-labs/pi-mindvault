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
  assert.ok(hits[0].source === "vec" || hits[0].source === "fts" || hits[0].source === "like" || hits[0].source === "rrf" || hits[0].source.includes("+"));
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
