import type { Db } from "./db.ts";
import { getProfile } from "./db.ts";
import { scopeKeysForRead } from "./scopes.ts";
import { drainQueue } from "./worker.ts";
import { vecMode } from "./vec.ts";

export function startSession(db: Db, args: { sessionId: string; piSessionId: string; cwd: string; repoRoot: string | null }): void {
  db.prepare("INSERT OR IGNORE INTO sessions(id,workspace_id,pi_session_id,cwd,repo_root,started_at) VALUES(?,?,?, ?, ?, ?)")
    .run(args.sessionId, "pi", args.piSessionId, args.cwd, args.repoRoot, Date.now() / 1000);
}

function topTerms(db: Db, sessionId: string, limit = 12): string[] {
  const rows = db.prepare("SELECT content FROM observations WHERE session_id=? ORDER BY importance DESC, id LIMIT 40").all(sessionId) as { content: string }[];
  const stop = new Set("the,a,an,and,or,to,of,in,on,for,with,is,are,was,were,it,this,that,these,those,as,at,by,from,will,must,can,should,be,been,have,has,had,our,your,their".split(","));
  const freq = new Map<string, number>();
  for (const r of rows) {
    for (const t of r.content.toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length < 4 || stop.has(t)) continue;
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
  }
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([t]) => t);
}

export function summarizeSession(db: Db, sessionId: string): string {
  const terms = topTerms(db, sessionId);
  const tops = db.prepare("SELECT content FROM observations WHERE session_id=? ORDER BY explicit DESC, importance DESC, id LIMIT 5").all(sessionId) as { content: string }[];
  const lines = tops.map((r) => `- ${r.content}`);
  const summary = [`Session ${sessionId} summary.`, terms.length > 0 ? `Key topics: ${terms.join(", ")}.` : "No salient topics.", ...lines].join("\n");
  db.prepare("INSERT INTO summaries(session_id,kind,content,tokens,created_at) VALUES(?, 'session', ?, ?, ?)")
    .run(sessionId, summary, Math.ceil(summary.length / 4), Date.now() / 1000);
  db.prepare("UPDATE sessions SET summary=?, ended_at=? WHERE id=?").run(summary, Date.now() / 1000, sessionId);
  return summary;
}

export function endSession(db: Db, sessionId: string): string {
  drainQueue(db, { limit: 50 });
  return summarizeSession(db, sessionId);
}

const CHARS_PER_TOKEN = 4;

export interface BuiltContext { text: string; summaryTokens: number; recentTokens: number }

export function buildContext(db: Db, args: { cwd: string; repoRoot?: string | null; tokenBudget?: number }): BuiltContext {
  const budget = args.tokenBudget ?? 2000;
  const summaryBudget = Math.floor(budget * 0.4);
  const recentBudget = budget - summaryBudget;
  const scopes = scopeKeysForRead({ cwd: args.cwd, repoRoot: args.repoRoot ?? null });
  const cards = getProfile(db, { peer: "user", scopeKeys: scopes });
  const sumRow = db.prepare("SELECT content FROM summaries WHERE kind='session' ORDER BY id DESC LIMIT 1").get() as { content: string } | undefined;
  const summaryText = (sumRow?.content ?? "").slice(0, summaryBudget * CHARS_PER_TOKEN);
  const recent = db.prepare(
    `SELECT m.content FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.cwd=? ORDER BY m.id DESC LIMIT 20`
  ).all(args.cwd) as { content: string }[];
  let recentText = "";
  for (const r of recent.reverse()) {
    const add = r.content.slice(0, 400) + "\n";
    if ((recentText.length + add.length) / CHARS_PER_TOKEN > recentBudget) break;
    recentText += add;
  }
  recentText = recentText.slice(0, recentBudget * CHARS_PER_TOKEN);
  const text = ["# Long-term memory (pi-mindvault)", ...cards, "", "## Session summary", summaryText, "", "## Recent", recentText]
    .join("\n").slice(0, budget * CHARS_PER_TOKEN);
  return { text, summaryTokens: Math.ceil(summaryText.length / CHARS_PER_TOKEN), recentTokens: Math.ceil(recentText.length / CHARS_PER_TOKEN) };
}

export function deleteSession(db: Db, sessionId: string): number {
  if (vecMode(db) === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid IN (SELECT id FROM observations WHERE session_id=?)").run(sessionId); } catch { /* js */ }
  }
  const a = db.prepare("DELETE FROM observations WHERE session_id=?").run(sessionId) as { changes: number | bigint };
  const m = db.prepare("DELETE FROM messages WHERE session_id=?").run(sessionId) as { changes: number | bigint };
  db.prepare("DELETE FROM summaries WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM session_peers WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM queue WHERE session_id=?").run(sessionId);
  db.prepare("DELETE FROM sessions WHERE id=?").run(sessionId);
  return Number(a.changes) + Number(m.changes);
}
