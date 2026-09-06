import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureHashEmbedder, cosine } from "../extensions/lib/embeddings.ts";

test("feature-hash is deterministic and normalized", async () => {
  const e = new FeatureHashEmbedder(256);
  const a = await e.embed("prefers explicit types");
  const b = await e.embed("prefers explicit types");
  assert.equal(e.dim, 256);
  assert.deepEqual(Array.from(a), Array.from(b));
  const norm = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  assert.ok(Math.abs(norm - 1) < 1e-5);
});

test("similar texts score higher than unrelated", async () => {
  const e = new FeatureHashEmbedder(256);
  const q = await e.embed("explicit types");
  const close = await e.embed("prefers explicit types everywhere");
  const far = await e.embed("banana pancakes");
  assert.ok(cosine(q, close) > cosine(q, far));
});
