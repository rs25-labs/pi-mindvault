import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveScope, scopeKeysForRead } from "../extensions/lib/scopes.ts";

test("default write scope is per-directory", () => {
  assert.equal(resolveScope({ cwd: "/home/u/proj", repoRoot: null }).kind, "dir");
});

test("read keys include global + dir + repo", () => {
  const keys = scopeKeysForRead({ cwd: "/home/u/proj", repoRoot: "/home/u/proj" });
  assert.ok(keys.includes("global"));
  assert.ok(keys.includes("dir:/home/u/proj"));
  assert.ok(keys.includes("repo:/home/u/proj"));
});
