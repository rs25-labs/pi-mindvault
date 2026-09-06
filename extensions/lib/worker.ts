import type { Db } from "./db.ts";
import { resolveScope, gitRootSync } from "./scopes.ts";
import { featureHash, activeEmbedder, isAsyncProvider } from "./embeddings.ts";
import { vecMode } from "./vec.ts";
import { redact } from "./redact.ts";

export interface IngestArgs { sessionId: string; peer: string; role: string; content: string; cwd: string; tokenCount?: number }

function signalImportance(sentence: string): number {
  let s = 0.35 + Math.min(0.3, sentence.length / 400);
  if (/\b(decided|decision|always|never|must|should|prefer|remember|important|fix|bug|error)\b/i.test(sentence)) s += 0.2;
  if (sentence.includes("?")) s += 0.1;
  if (/```/.test(sentence)) s += 0.1;
  return Math.min(1, Math.round(s * 100) / 100);
}

const CODE_FENCE = /```[\s\S]*?```/g;
const CHUNK_TARGET = 400;
const CHUNK_MAX = 800;
const CODE_MAX = 1500;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function chunkMessage(text: string): string[] {
  const fences: string[] = [];
  const prose = text.replace(CODE_FENCE, (m) => { fences.push(m.length > CODE_MAX ? m.slice(0, CODE_MAX) : m); return "\n"; });
  const sents = splitSentences(prose).filter((s) => s.length >= 8);
  const groups: string[] = [];
  let i = 0;
  while (i < sents.length) {
    let chunk = sents[i];
    let j = i + 1;
    while (j < sents.length && chunk.length + 1 + sents[j].length <= CHUNK_TARGET) { chunk += " " + sents[j]; j++; }
    groups.push(chunk);
    i = (j > i + 1 && j < sents.length) ? j - 1 : j; // 1-sentence overlap between multi-sentence chunks
  }
  const keepFences = fences.map((f) => f.trim()).filter((f) => f.length > 24 && f.length <= CODE_MAX);
  const keepGroups = groups.map((c) => c.trim()).filter((c) => c.length > 24 && c.length <= CHUNK_MAX);
  return [...keepFences, ...keepGroups];
}

function scopeIdOf(db: Db, scopeKey: string): number {
  const kind = scopeKey === "global" ? "global" : scopeKey.startsWith("dir:") ? "dir" : scopeKey.startsWith("repo:") ? "repo" : "session";
  db.prepare("INSERT OR IGNORE INTO scopes(workspace_id,kind,key) VALUES('pi',?,?)").run(kind, scopeKey);
  return (db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number }).id;
}

function embedRow(db: Db, id: number, content: string): void {
  if (isAsyncProvider()) return; // real providers fill NULL rows via embedUpgrade
  try {
    const v = Buffer.from(featureHash(content, activeEmbedder().dim).buffer);
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, id);
    if (vecMode(db) === "vec0") {
      try { db.prepare("INSERT INTO vec_observations(rowid, embedding) VALUES(?,?)").run(id, v); } catch { /* js covers */ }
    }
  } catch { /* embedding never blocks the worker */ }
}

export function ingestMessage(db: Db, args: IngestArgs): number {
  db.prepare("INSERT OR IGNORE INTO sessions(id,workspace_id,cwd,started_at) VALUES(?,?,?,?)")
    .run(args.sessionId, "pi", args.cwd, Date.now() / 1000);
  db.prepare("INSERT OR IGNORE INTO session_peers(session_id,peer_id) VALUES(?,?)").run(args.sessionId, args.peer);
  const r = db.prepare("INSERT INTO messages(session_id,peer_id,role,content,timestamp,token_count,observed) VALUES(?,?,?,?,?,?,0)")
    .run(args.sessionId, args.peer, args.role, redact(args.content, { cwd: args.cwd }), Date.now() / 1000, args.tokenCount ?? null) as { lastInsertRowid: number | bigint };
  const mid = Number(r.lastInsertRowid);
  db.prepare("INSERT INTO queue(session_id,status,attempts,payload_json,created_at) VALUES(?, 'pending', 0, ?, ?)")
    .run(args.sessionId, JSON.stringify({ messageId: mid, cwd: args.cwd, peer: args.peer }), Date.now() / 1000);
  return mid;
}

export function drainQueue(db: Db, opts?: { limit?: number }): number {
  const limit = opts?.limit ?? 20;
  const jobs = db.prepare("SELECT id, session_id, attempts, payload_json FROM queue WHERE status='pending' ORDER BY id LIMIT ?")
    .all(limit) as { id: number; session_id: string; attempts: number; payload_json: string }[];
  let done = 0;
  for (const j of jobs) {
    const claimed = db.prepare("UPDATE queue SET status='processing', attempts=attempts+1 WHERE id=? AND status='pending'").run(j.id) as { changes: number | bigint };
    if (Number(claimed.changes) === 0) continue; // lost CAS race
    try {
      const p = JSON.parse(j.payload_json) as { messageId: number; cwd: string; peer: string };
      deriveMessage(db, p);
      db.prepare("UPDATE queue SET status='done' WHERE id=?").run(j.id);
      done++;
    } catch {
      const attempts = j.attempts + 1;
      db.prepare("UPDATE queue SET status=? WHERE id=?").run(attempts >= 3 ? "failed" : "pending", j.id);
    }
  }
  return done;
}

function deriveMessage(db: Db, p: { messageId: number; cwd: string; peer: string }): void {
  const msg = db.prepare("SELECT session_id, role, content, observed FROM messages WHERE id=?").get(p.messageId) as
    { session_id: string; role: string; content: string; observed: number } | undefined;
  if (!msg || msg.observed) return;
  if (msg.role === "tool") { db.prepare("UPDATE messages SET observed=1 WHERE id=?").run(p.messageId); return; }
  const repo = gitRootSync(p.cwd);
  const scope = resolveScope({ cwd: p.cwd, repoRoot: repo, explicit: null });
  const sid = scopeIdOf(db, scope.key);
  const sents = chunkMessage(msg.content).slice(0, 12);
  const now = Date.now() / 1000;
  for (const s of sents) {
    const clean = redact(s, { cwd: p.cwd });
    const r = db.prepare("INSERT INTO observations(workspace_id,peer_id,session_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi',?,?,?,?,?,?,0,0,?,?)").run(
      p.peer, msg.session_id, sid, "episodic", clean, signalImportance(clean), now, now,
    ) as { lastInsertRowid: number | bigint };
    embedRow(db, Number(r.lastInsertRowid), clean);
  }
  db.prepare("UPDATE messages SET observed=1 WHERE id=?").run(p.messageId);
}

export function queueStatus(db: Db): { pending: number; failed: number } {
  const p = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get() as { n: number };
  const f = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='failed'").get() as { n: number };
  return { pending: p.n, failed: f.n };
}
