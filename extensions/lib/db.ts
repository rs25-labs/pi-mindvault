import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";

export type Db = DatabaseSync;
export type MemType = "episodic" | "semantic" | "procedural" | "working";

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS state_meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, config_json TEXT);
CREATE TABLE IF NOT EXISTS peers(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS scopes(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, pi_session_id TEXT UNIQUE, cwd TEXT, repo_root TEXT, scope_id INTEGER, summary TEXT, started_at REAL, ended_at REAL);
CREATE TABLE IF NOT EXISTS session_peers(session_id TEXT NOT NULL, peer_id TEXT NOT NULL, PRIMARY KEY(session_id, peer_id));
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, peer_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp REAL NOT NULL, token_count INTEGER);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL DEFAULT 'pi', peer_id TEXT NOT NULL, session_id TEXT, scope_id INTEGER NOT NULL, mem_type TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, explicit INTEGER NOT NULL DEFAULT 0, supersedes_id INTEGER, expiry REAL, accesses INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS fts_observations USING fts5(content, content='observations', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS obs_fts_insert AFTER INSERT ON observations BEGIN INSERT INTO fts_observations(rowid, content) VALUES (new.id, new.content); END;
CREATE TRIGGER IF NOT EXISTS obs_fts_delete AFTER DELETE ON observations BEGIN INSERT INTO fts_observations(fts_observations, rowid, content) VALUES ('delete', old.id, old.content); END;
CREATE TRIGGER IF NOT EXISTS obs_fts_update AFTER UPDATE OF content ON observations BEGIN INSERT INTO fts_observations(fts_observations, rowid, content) VALUES ('delete', old.id, old.content); INSERT INTO fts_observations(rowid, content) VALUES (new.id, new.content); END;
CREATE TABLE IF NOT EXISTS peer_cards(peer_id TEXT NOT NULL, scope_id INTEGER NOT NULL, content TEXT NOT NULL, updated_at REAL NOT NULL, PRIMARY KEY(peer_id, scope_id));
CREATE TABLE IF NOT EXISTS summaries(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, peer_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, tokens INTEGER, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS queue(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, payload_json TEXT, created_at REAL NOT NULL);
CREATE TABLE IF NOT EXISTS recall_log(id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, scope_id INTEGER, result_ids_json TEXT, scores_json TEXT, hit INTEGER NOT NULL, pi_session_id TEXT, timestamp REAL NOT NULL);
CREATE INDEX IF NOT EXISTS idx_obs_peer_scope ON observations(peer_id, scope_id, mem_type);
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, timestamp);
`;

export function openMindvault(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  db.exec(SCHEMA);
  const v = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  if (!v) db.prepare("INSERT INTO state_meta(key,value) VALUES('schema_version','1')").run();
  db.prepare("INSERT OR IGNORE INTO workspaces(id,config_json) VALUES('pi','{}')").run();
  return db;
}

function scopeId(db: Db, workspaceId: string, scopeKey: string): number {
  const kind = scopeKey === "global" ? "global" : scopeKey.startsWith("dir:") ? "dir" : scopeKey.startsWith("repo:") ? "repo" : "session";
  db.prepare("INSERT OR IGNORE INTO scopes(workspace_id,kind,key) VALUES(?,?,?)").run(workspaceId, kind, scopeKey);
  const row = db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number };
  return row.id;
}

function ensurePeer(db: Db, peer: string): void {
  const kind = peer === "pi-agent" ? "agent" : "user";
  db.prepare("INSERT OR IGNORE INTO peers(id,workspace_id,kind,created_at) VALUES(?,?,?,?)").run(peer, "pi", kind, Date.now() / 1000);
}

export function remember(db: Db, args: { peer: string; content: string; memType: MemType; scopeKey: string; explicit: 0 | 1; cwd: string; importance?: number }): number {
  const clean = redact(args.content, { cwd: args.cwd });
  ensurePeer(db, args.peer);
  const sid = scopeId(db, "pi", args.scopeKey);
  const now = Date.now() / 1000;
  const r = db.prepare("INSERT INTO observations(workspace_id,peer_id,session_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi',?,NULL,?,?,?,COALESCE(?,0.5),?,0,?,?)").run(args.peer, sid, args.memType, clean, args.importance ?? null, args.explicit, now, now) as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  // refresh peer card for global scope (fast inject source)
  if (args.scopeKey === "global") {
    const rows = db.prepare("SELECT content FROM observations WHERE peer_id=? AND scope_id=? ORDER BY id DESC LIMIT 20").all(args.peer, sid) as { content: string }[];
    const card = rows.map((x) => `- ${x.content}`).join("\n").slice(0, 4000);
    db.prepare("INSERT INTO peer_cards(peer_id,scope_id,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(peer_id,scope_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at").run(args.peer, sid, card, now);
  }
  return id;
}

export interface Hit { id: number; content: string; score: number; source: string; scopeKey: string }

export function recallSearch(db: Db, args: { query: string; scopeKeys: string[]; limit?: number }): Hit[] {
  const limit = args.limit ?? 5;
  if (args.scopeKeys.length === 0) return [];
  const placeholders = args.scopeKeys.map(() => "?").join(",");
  // FTS5-only in M1 (vectors land in M2); LIKE fallback when FTS errors
  try {
    const rows = db.prepare(
      `SELECT o.id, o.content, s.key AS scopeKey, bm25(fts_observations) AS rank
       FROM fts_observations f JOIN observations o ON o.id = f.rowid JOIN scopes s ON s.id = o.scope_id
       WHERE fts_observations MATCH ? AND s.key IN (${placeholders})
       ORDER BY rank LIMIT ?`
    ).all(args.query, ...args.scopeKeys, limit) as { id: number; content: string; scopeKey: string; rank: number }[];
    logRecall(db, args.query, null, rows.map((r) => r.id), rows.map((r) => r.rank));
    return rows.map((r) => ({ id: r.id, content: r.content, score: -r.rank, source: "fts", scopeKey: r.scopeKey }));
  } catch {
    const like = `%${args.query.split(/\s+/)[0] ?? args.query}%`;
    const rows = db.prepare(
      `SELECT o.id, o.content, s.key AS scopeKey FROM observations o JOIN scopes s ON s.id=o.scope_id
       WHERE o.content LIKE ? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT ?`
    ).all(like, ...args.scopeKeys, limit) as { id: number; content: string; scopeKey: string }[];
    logRecall(db, args.query, null, rows.map((r) => r.id), rows.map(() => 0));
    return rows.map((r) => ({ id: r.id, content: r.content, score: 0, source: "like", scopeKey: r.scopeKey }));
  }
}

function logRecall(db: Db, query: string, scopeIdV: number | null, ids: number[], scores: number[]): void {
  db.prepare("INSERT INTO recall_log(query,scope_id,result_ids_json,scores_json,hit,pi_session_id,timestamp) VALUES(?,?,?,?,?,?,?)")
    .run(query, scopeIdV, JSON.stringify(ids), JSON.stringify(scores), ids.length > 0 ? 1 : 0, null, Date.now() / 1000);
}

export function getProfile(db: Db, args: { peer: string; scopeKeys: string[] }): string[] {
  if (args.scopeKeys.length === 0) return [];
  const placeholders = args.scopeKeys.map(() => "?").join(",");
  const rows = db.prepare(
    `SELECT c.content FROM peer_cards c JOIN scopes s ON s.id=c.scope_id WHERE c.peer_id=? AND s.key IN (${placeholders})`
  ).all(args.peer, ...args.scopeKeys) as { content: string }[];
  if (rows.length > 0) return rows.map((r) => r.content);
  // fallback: latest global observations
  const fb = db.prepare(
    `SELECT o.content FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE o.peer_id=? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT 10`
  ).all(args.peer, ...args.scopeKeys) as { content: string }[];
  return fb.map((r) => r.content);
}

export function dbStatus(db: Db): { schemaVersion: number; observations: number; ftsCount: number; queuePending: number; dbSize: number | null } {
  const v = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string };
  const c = db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
  let fts = 0;
  try { fts = (db.prepare("SELECT COUNT(*) AS n FROM fts_observations").get() as { n: number }).n; } catch { fts = -1; }
  const q = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get() as { n: number };
  return { schemaVersion: Number(v.value), observations: c.n, ftsCount: fts, queuePending: q.n, dbSize: null };
}
