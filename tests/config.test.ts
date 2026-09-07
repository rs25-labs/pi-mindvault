import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempConfig(fn: () => Promise<void>): Promise<void> {
  const prev = process.env.MINDVAULT_CONFIG_PATH;
  process.env.MINDVAULT_CONFIG_PATH = join(mkdtempSync(join(tmpdir(), "mvcfg-")), "config.json");
  try { await fn(); } finally { if (prev === undefined) delete process.env.MINDVAULT_CONFIG_PATH; else process.env.MINDVAULT_CONFIG_PATH = prev; }
}

test("loadConfig returns hash defaults when no file exists", async () => {
  await withTempConfig(async () => {
    const { loadConfig } = await import("../extensions/lib/config.ts");
    const c = loadConfig();
    assert.equal(c.embeddings.provider, "hash");
    assert.equal(c.quiet, false);
    assert.equal(c.maxObs, 50000);
  });
});

test("writeConfig then loadConfig round-trips the local provider", async () => {
  await withTempConfig(async () => {
    const { loadConfig, writeConfig, configPath } = await import("../extensions/lib/config.ts");
    writeConfig({ embeddings: { provider: "local", model: "fast-bge-small-en-v1.5", dim: 384 }, quiet: true });
    const c = loadConfig();
    assert.equal(c.embeddings.provider, "local");
    assert.equal(c.embeddings.dim, 384);
    assert.equal(c.quiet, true);
    const onDisk = JSON.parse(readFileSync(configPath(), "utf8"));
    assert.equal(onDisk.embeddings.provider, "local");
  });
});

test("an invalid provider in the file coerces to hash", async () => {
  await withTempConfig(async () => {
    const { loadConfig, writeConfig } = await import("../extensions/lib/config.ts");
    writeConfig({ embeddings: { provider: "bogus" as unknown as "hash" } });
    assert.equal(loadConfig().embeddings.provider, "hash");
  });
});
