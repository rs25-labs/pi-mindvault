import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMindvault, remember, recallSearch, forgetObservation, deleteScope } from "../extensions/lib/db.ts";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "mvf-")), "memory.db");
}

test("forget purges FTS + vec", () => {
  const db = openMindvault(tmpDb());
  const id = remember(db, { peer: "u", content: "temporary s3cr3t factoid", memType: "semantic", scopeKey: "dir:/a", explicit: 1, cwd: "/a" });
  assert.equal(forgetObservation(db, id), true);
  const hits = recallSearch(db, { query: "factoid", scopeKeys: ["dir:/a"], limit: 5 });
  assert.equal(hits.length, 0);
  db.close();
});

test("deleteScope removes scoped rows only", () => {
  const db = openMindvault(tmpDb());
  remember(db, { peer: "u", content: "projA alpha", memType: "semantic", scopeKey: "dir:/projA", explicit: 0, cwd: "/projA" });
  remember(db, { peer: "u", content: "global beta", memType: "semantic", scopeKey: "global", explicit: 0, cwd: "/projA" });
  const n = deleteScope(db, "dir:/projA");
  assert.equal(n, 1);
  const hits = recallSearch(db, { query: "beta", scopeKeys: ["global"], limit: 5 });
  assert.equal(hits.length, 1);
  db.close();
});
