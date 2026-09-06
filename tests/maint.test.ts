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
