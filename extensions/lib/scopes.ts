import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type ScopeKind = "global" | "dir" | "repo" | "session";
export interface ScopeRef { kind: ScopeKind; key: string }

export function dirKey(cwd: string): string { return `dir:${cwd}`; }
export function repoKey(root: string): string { return `repo:${root}`; }

export function resolveScope(args: { cwd: string; repoRoot: string | null; explicit?: "global" | null }): ScopeRef {
  if (args.explicit === "global") return { kind: "global", key: "global" };
  return { kind: "dir", key: dirKey(args.cwd) };
}

export function scopeKeysForRead(args: { cwd: string; repoRoot: string | null }): string[] {
  const keys = ["global", dirKey(args.cwd)];
  if (args.repoRoot) keys.push(repoKey(args.repoRoot));
  return keys;
}

export function gitRootSync(cwd: string): string | null {
  let cur = resolve(cwd);
  for (let i = 0; i < 12; i++) {
    if (existsSync(cur + "/.git")) return cur;
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}
