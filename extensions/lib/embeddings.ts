export interface Embedder { readonly dim: number; readonly name: string; embed(text: string): Promise<Float32Array>; }

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are L2-normalized
}

export function featureHash(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    v[fnv1a(toks[i]) % dim] += 1;
    if (i > 0) v[fnv1a(toks[i - 1] + " " + toks[i]) % dim] += 0.5;
  }
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export class FeatureHashEmbedder implements Embedder {
  readonly name = "feature-hash";
  constructor(readonly dim = 256) {}
  async embed(text: string): Promise<Float32Array> {
    return featureHash(text, this.dim);
  }
}

export class ApiEmbedder implements Embedder {
  readonly name = "api";
  constructor(readonly dim: number, private baseUrl: string, private key: string, private model: string) {}
  async embed(text: string): Promise<Float32Array> {
    const res = await fetch(this.baseUrl.replace(/\/$/, "") + "/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    const arr = Float32Array.from(json.data[0].embedding.slice(0, this.dim));
    let n = 0;
    for (let i = 0; i < arr.length; i++) n += arr[i] * arr[i];
    n = Math.sqrt(n) || 1;
    for (let i = 0; i < arr.length; i++) arr[i] /= n;
    return arr;
  }
}

export function defaultEmbedder(): Embedder {
  const base = process.env.MINDVAULT_EMBEDDINGS_URL ?? "";
  const key = process.env.MINDVAULT_EMBEDDINGS_KEY ?? "";
  const model = process.env.MINDVAULT_EMBEDDINGS_MODEL ?? "";
  const dim = Number(process.env.MINDVAULT_EMBEDDINGS_DIM ?? "0");
  if (base && key && model && dim > 0) return new ApiEmbedder(dim, base, key, model);
  return new FeatureHashEmbedder(256);
}
