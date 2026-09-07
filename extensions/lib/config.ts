import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Provider = "hash" | "local" | "api";

export interface MindvaultConfig {
  embeddings: { provider: Provider; model?: string; dim?: number; url?: string; key?: string };
  quiet: boolean;
  maxObs: number;
}

const DEFAULTS: MindvaultConfig = { embeddings: { provider: "hash" }, quiet: false, maxObs: 50000 };

export function configPath(): string {
  return process.env.MINDVAULT_CONFIG_PATH ?? join(homedir(), ".pi", "memory", "config.json");
}

function readFile(): Partial<MindvaultConfig> {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed as Partial<MindvaultConfig> : {};
  } catch {
    return {}; // no file or bad json → defaults
  }
}

function coerceProvider(p: unknown): Provider {
  return p === "local" || p === "api" ? p : "hash";
}

export function loadConfig(): MindvaultConfig {
  const file = readFile();
  const cfg: MindvaultConfig = {
    embeddings: { ...DEFAULTS.embeddings, ...(file.embeddings ?? {}), provider: coerceProvider(file.embeddings?.provider) },
    quiet: typeof file.quiet === "boolean" ? file.quiet : DEFAULTS.quiet,
    maxObs: typeof file.maxObs === "number" && file.maxObs > 0 ? file.maxObs : DEFAULTS.maxObs,
  };
  // env overrides (optional; never required)
  const e = cfg.embeddings;
  if (process.env.MINDVAULT_EMBEDDINGS_PROVIDER) e.provider = coerceProvider(process.env.MINDVAULT_EMBEDDINGS_PROVIDER.toLowerCase());
  if (process.env.MINDVAULT_EMBEDDINGS_MODEL) e.model = process.env.MINDVAULT_EMBEDDINGS_MODEL;
  if (process.env.MINDVAULT_EMBEDDINGS_DIM) e.dim = Number(process.env.MINDVAULT_EMBEDDINGS_DIM);
  if (process.env.MINDVAULT_EMBEDDINGS_URL) e.url = process.env.MINDVAULT_EMBEDDINGS_URL;
  if (process.env.MINDVAULT_EMBEDDINGS_KEY) e.key = process.env.MINDVAULT_EMBEDDINGS_KEY;
  if (process.env.MINDVAULT_QUIET === "1") cfg.quiet = true;
  if (process.env.MINDVAULT_MAX_OBS) { const n = Number(process.env.MINDVAULT_MAX_OBS); if (n > 0) cfg.maxObs = n; }
  return cfg;
}

export function writeConfig(update: Partial<MindvaultConfig>): MindvaultConfig {
  const cur = readFile();
  const embeddings = { ...(cur.embeddings ?? {}), ...(update.embeddings ?? {}) };
  embeddings.provider = coerceProvider(embeddings.provider);
  const merged: MindvaultConfig = {
    embeddings: embeddings as MindvaultConfig["embeddings"],
    quiet: update.quiet ?? cur.quiet ?? DEFAULTS.quiet,
    maxObs: update.maxObs ?? cur.maxObs ?? DEFAULTS.maxObs,
  };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, JSON.stringify(merged, null, 2) + "\n");
  try { chmodSync(p, 0o600); } catch { /* best-effort */ }
  return merged;
}
