import type { Db } from "./db.ts";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

export type VecMode = "vec0" | "js";

export function findVecExtension(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const { getLoadablePath } = require("sqlite-vec") as { getLoadablePath(): string };
    const p = getLoadablePath();
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export function loadVecExtension(db: Db): VecMode {
  const path = findVecExtension();
  if (path) {
    try {
      (db as unknown as { loadExtension(p: string): void }).loadExtension(path);
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_observations USING vec0(embedding FLOAT[256])`);
      recordMode(db, "vec0");
      return "vec0";
    } catch {
      // fall through to js (e.g. runtime disallows extension loading)
    }
  }
  recordMode(db, "js");
  return "js";
}

function recordMode(db: Db, mode: VecMode): void {
  db.prepare("INSERT INTO state_meta(key,value) VALUES('vec_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(mode);
}

export function vecMode(db: Db): VecMode {
  try {
    const row = db.prepare("SELECT value FROM state_meta WHERE key='vec_mode'").get() as { value: string } | undefined;
    return row?.value === "vec0" ? "vec0" : "js";
  } catch {
    return "js";
  }
}
