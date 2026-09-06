import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../extensions/lib/redact.ts";

test("redacts token patterns", () => {
  const out = redact("key=sk-abc123xyz plus ghp_deadbeef1234");
  assert.ok(!out.includes("sk-abc123xyz"));
  assert.ok(!out.includes("ghp_deadbeef1234"));
});

test("jails outside-cwd paths", () => {
  const out = redact("see /etc/passwd for hints", { cwd: "/home/u/proj" });
  assert.ok(out.includes("<outside-cwd>") || out.includes("/etc/passwd") === false);
});
