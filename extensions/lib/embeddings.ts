import { loadConfig } from "./config.ts";

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

function l2norm(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export function featureHash(text: string, dim: number): Float32Array {
  const v = new Float32Array(dim);
  const toks = text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    v[fnv1a(toks[i]) % dim] += 1;
    if (i > 0) v[fnv1a(toks[i - 1] + " " + toks[i]) % dim] += 0.5;
  }
  return l2norm(v);
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
    const url = this.baseUrl.replace(/\/$/, "") + "/embeddings";
    if (!url.startsWith("https://")) throw new Error("embeddings API must use https");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
      body: JSON.stringify({ model: this.model, input: text }),
    });
    if (!res.ok) throw new Error(`embeddings API ${res.status}`);
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return l2norm(Float32Array.from(json.data[0].embedding.slice(0, this.dim)));
  }
}

// Local model provider. Uses `fastembed` (wraps onnxruntime-node) as an optional
// dependency, lazily loaded and cached; the model file downloads on first use. If the
// dependency or model is unavailable, embed() throws and callers fall back to feature-hash.
export class LocalEmbedder implements Embedder {
  readonly name: string;
  private pipe: ((text: string) => Promise<number[]>) | null = null;
  private loading: Promise<void> | null = null;
  constructor(readonly dim: number, private model: string) { this.name = `local:${model}`; }
  private async load(): Promise<void> {
    const spec = "fastembed";
    type Runtime = { init(opts: { model: string }): Promise<{ embed(texts: string[]): AsyncGenerator<number[][]> }> };
    const mod = await import(spec) as unknown as { TextEmbedding?: Runtime; FlagEmbedding?: Runtime };
    const runtime = mod.TextEmbedding ?? mod.FlagEmbedding;
    if (!runtime) throw new Error("fastembed: no embedding class exported");
    const fe = await runtime.init({ model: this.model });
    this.pipe = async (text: string) => {
      for await (const batch of fe.embed([text])) return Array.from(batch[0] ?? []);
      return [];
    };
  }
  async embed(text: string): Promise<Float32Array> {
    if (!this.pipe) { this.loading ??= this.load(); await this.loading; }
    return l2norm(Float32Array.from((await this.pipe!(text)).slice(0, this.dim)));
  }
}

export function defaultEmbedder(): Embedder {
  const c = loadConfig().embeddings;
  if (c.provider === "local") return new LocalEmbedder(c.dim && c.dim > 0 ? c.dim : 384, c.model || "BAAI/bge-small-en-v1.5");
  if (c.provider === "api" && c.url && c.key && c.model && c.dim && c.dim > 0) return new ApiEmbedder(c.dim, c.url, c.key, c.model);
  return new FeatureHashEmbedder(256);
}

let active: Embedder | null = null;

export function activeEmbedder(): Embedder {
  return (active ??= defaultEmbedder());
}

export function setActiveEmbedder(e: Embedder | null): void {
  active = e;
}

export function isAsyncProvider(): boolean {
  return activeEmbedder().name !== "feature-hash";
}

export async function embed(text: string): Promise<Float32Array> {
  const e = activeEmbedder();
  try {
    return await e.embed(text);
  } catch {
    return featureHash(text, e.dim); // dim-consistent fallback keeps stored vectors comparable
  }
}
