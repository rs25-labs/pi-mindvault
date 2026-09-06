import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { redact } from "./redact.ts";
import { loadVecExtension, vecMode } from "./vec.ts";
import { defaultEmbedder, featureHash } from "./embeddings.ts";
import { runMigrations } from "./migrations.ts";

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
CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, peer_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, timestamp REAL NOT NULL, token_count INTEGER, observed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS observations(id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL DEFAULT 'pi', peer_id TEXT NOT NULL, session_id TEXT, scope_id INTEGER NOT NULL, mem_type TEXT NOT NULL, content TEXT NOT NULL, importance REAL NOT NULL DEFAULT 0.5, explicit INTEGER NOT NULL DEFAULT 0, supersedes_id INTEGER, expiry REAL, accesses INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL, updated_at REAL NOT NULL, embedding BLOB);
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path, { allowLoadExtension: true } as unknown as Record<string, unknown>);
  try { chmodSync(path, 0o600); } catch { /* best-effort; never block open */ }
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(SCHEMA);
  runMigrations(db);
  db.prepare("INSERT OR IGNORE INTO workspaces(id,config_json) VALUES('pi','{}')").run();
  loadVecExtension(db);
  ensureEmbeddingDim(db);
  backfillEmbeddings(db);
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

function ensureEmbeddingDim(db: Db): void {
  const dim = defaultEmbedder().dim;
  const row = db.prepare("SELECT value FROM state_meta WHERE key='embedding_dim'").get() as { value?: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO state_meta(key,value) VALUES('embedding_dim',?)").run(String(dim));
    return;
  }
  if (Number(row.value) !== dim) {
    // embedding model changed: drop native vectors, null stored blobs for lazy re-embed
    try { db.exec("DELETE FROM vec_observations"); } catch { /* js mode: nothing */ }
    db.prepare("UPDATE observations SET embedding=NULL").run();
    db.prepare("UPDATE state_meta SET value=? WHERE key='embedding_dim'").run(String(dim));
  }
}

function toBlob(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function fromBlob(b: Uint8Array | Buffer | null): Float32Array | null {
  if (!b) return null;
  const buf = Buffer.from(b);
  if (buf.byteLength % 4 !== 0 || buf.byteLength === 0) return null;
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function jsCosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export function backfillEmbeddings(db: Db, limit = 200): number {
  const rows = db.prepare("SELECT id, content FROM observations WHERE embedding IS NULL LIMIT ?").all(limit) as { id: number; content: string }[];
  if (rows.length === 0) return 0;
  const dim = defaultEmbedder().dim;
  const mode = vecMode(db);
  let n = 0;
  for (const r of rows) {
    const v = toBlob(featureHash(r.content, dim));
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, r.id);
    if (mode === "vec0") {
      try { db.prepare("INSERT OR REPLACE INTO vec_observations(rowid, embedding) VALUES(?,?)").run(r.id, v); } catch { /* js scan covers */ }
    }
    n++;
  }
  return n;
}

export function remember(db: Db, args: { peer: string; content: string; memType: MemType; scopeKey: string; explicit: 0 | 1; cwd: string; importance?: number }): number {
  const clean = redact(args.content, { cwd: args.cwd });
  ensurePeer(db, args.peer);
  const sid = scopeId(db, "pi", args.scopeKey);
  const now = Date.now() / 1000;
  const r = db.prepare("INSERT INTO observations(workspace_id,peer_id,session_id,scope_id,mem_type,content,importance,explicit,accesses,created_at,updated_at) VALUES('pi',?,NULL,?,?,?,COALESCE(?,0.5),?,0,?,?)").run(args.peer, sid, args.memType, clean, args.importance ?? null, args.explicit, now, now) as { lastInsertRowid: number | bigint };
  const id = Number(r.lastInsertRowid);
  try {
    const v = toBlob(featureHash(clean, defaultEmbedder().dim));
    db.prepare("UPDATE observations SET embedding=? WHERE id=?").run(v, id);
    if (vecMode(db) === "vec0") {
      try { db.prepare("INSERT INTO vec_observations(rowid, embedding) VALUES(?,?)").run(id, v); } catch { /* js fallback covers */ }
    }
  } catch { /* embedding never blocks a write */ }
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
  const K = 60;
  const rrf = new Map<number, { rrf: number; sources: string[] }>();
  const add = (id: number, rank: number, src: string) => {
    const cur = rrf.get(id) ?? { rrf: 0, sources: [] as string[] };
    cur.rrf += 1 / (K + rank);
    if (!cur.sources.includes(src)) cur.sources.push(src);
    rrf.set(id, cur);
  };
  // FTS leg (rank = order)
  try {
    const rows = db.prepare(
      `SELECT o.id FROM fts_observations f JOIN observations o ON o.id = f.rowid JOIN scopes s ON s.id = o.scope_id
       WHERE fts_observations MATCH ? AND s.key IN (${placeholders}) ORDER BY bm25(fts_observations) LIMIT 20`
    ).all(args.query, ...args.scopeKeys) as { id: number }[];
    rows.forEach((r, i) => add(r.id, i, "fts"));
  } catch {
    const like = `%${args.query.split(/\s+/)[0] ?? args.query}%`;
    const rows = db.prepare(
      `SELECT o.id FROM observations o JOIN scopes s ON s.id=o.scope_id
       WHERE o.content LIKE ? AND s.key IN (${placeholders}) ORDER BY o.id DESC LIMIT 20`
    ).all(like, ...args.scopeKeys) as { id: number }[];
    rows.forEach((r, i) => add(r.id, i, "like"));
  }
  // vector leg: vec0 when available, JS cosine scan otherwise
  try {
    if (vecMode(db) === "vec0") {
      const qv = toBlob(featureHash(args.query, defaultEmbedder().dim));
      const rows = db.prepare(
        `SELECT o.id FROM vec_observations v JOIN observations o ON o.id = v.rowid JOIN scopes s ON s.id=o.scope_id
         WHERE v.embedding MATCH ? AND k = 20 AND s.key IN (${placeholders})`
      ).all(qv, ...args.scopeKeys) as { id: number }[];
      if (rows.length === 0) throw new Error("vec0-empty");
      rows.forEach((r, i) => add(r.id, i, "vec"));
    } else {
      throw new Error("js-scan");
    }
  } catch {
    const qf = featureHash(args.query, defaultEmbedder().dim);
    const rows = db.prepare(
      `SELECT o.id, o.embedding FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE s.key IN (${placeholders})`
    ).all(...args.scopeKeys) as { id: number; embedding: Buffer | null }[];
    rows
      .map((r) => ({ id: r.id, s: r.embedding ? jsCosine(qf, fromBlob(r.embedding)!) : -1 }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 20)
      .forEach((r, i) => add(r.id, i, "vec"));
  }
  if (rrf.size === 0) { logRecall(db, args.query, null, [], []); return []; }
  const ids = [...rrf.keys()];
  const meta = db.prepare(
    `SELECT o.id, o.content, o.importance, o.explicit, o.created_at, s.key AS scopeKey FROM observations o JOIN scopes s ON s.id=o.scope_id WHERE o.id IN (${ids.map(() => "?").join(",")})`
  ).all(...ids) as { id: number; content: string; importance: number; explicit: number; created_at: number; scopeKey: string }[];
  const now = Date.now() / 1000;
  const ranked = meta
    .map((m) => {
      const r = rrf.get(m.id)!;
      const rec = 1 / (1 + Math.max(0, now - m.created_at) / 86400);
      const score = 0.6 * r.rrf + 0.25 * rec + 0.15 * Math.min(1, Math.max(0, m.importance)) + (m.explicit ? 0.1 : 0);
      return { id: m.id, content: m.content, score, source: r.sources.sort().join("+") || "rrf", scopeKey: m.scopeKey };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  logRecall(db, args.query, null, ranked.map((r) => r.id), ranked.map((r) => r.score));
  return ranked;
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

export function dbStatus(db: Db): { schemaVersion: number; observations: number; ftsCount: number; queuePending: number; dbSize: number | null; embeddingDim: number | null; vecMode: string } {
  const v = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value: string };
  const c = db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number };
  let fts = 0;
  try { fts = (db.prepare("SELECT COUNT(*) AS n FROM fts_observations").get() as { n: number }).n; } catch { fts = -1; }
  const q = db.prepare("SELECT COUNT(*) AS n FROM queue WHERE status='pending'").get() as { n: number };
  let dim: number | null = null;
  try { dim = Number((db.prepare("SELECT value FROM state_meta WHERE key='embedding_dim'").get() as { value: string }).value); } catch { dim = null; }
  return { schemaVersion: Number(v.value), observations: c.n, ftsCount: fts, queuePending: q.n, dbSize: null, embeddingDim: dim, vecMode: vecMode(db) };
}

export function forgetObservation(db: Db, id: number): boolean {
  if (vecMode(db) === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid=?").run(id); } catch { /* js mode covers */ }
  }
  const r = db.prepare("DELETE FROM observations WHERE id=?").run(id) as { changes: number | bigint };
  return Number(r.changes) > 0;
}

export function deleteScope(db: Db, scopeKey: string): number {
  const row = db.prepare("SELECT id FROM scopes WHERE key=?").get(scopeKey) as { id: number } | undefined;
  if (!row) return 0;
  if (vecMode(db) === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid IN (SELECT id FROM observations WHERE scope_id=?)").run(row.id); } catch { /* js */ }
  }
  const r = db.prepare("DELETE FROM observations WHERE scope_id=?").run(row.id) as { changes: number | bigint };
  db.prepare("DELETE FROM peer_cards WHERE scope_id=?").run(row.id);
  db.prepare("DELETE FROM scopes WHERE id=?").run(row.id);
  return Number(r.changes);
}
