// Model-call spike (installed pi): ExtensionContext exposes modelRegistry/model info
// but no supported extension-invoked chat/completions path, so Dreamer is heuristic.
// Set MINDVAULT_LLM_DREAM=1 in future when pi exposes one; heuristic stays the default.
import type { Db } from "./db.ts";
import { featureHash, defaultEmbedder } from "./embeddings.ts";
import { vecMode } from "./vec.ts";

export interface DreamStats { merged: number; pruned: number; cards: number }

function embOf(content: string): Float32Array {
  return featureHash(content, defaultEmbedder().dim);
}
function cos(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return -1;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

export function maxObs(): number {
  const n = Number(process.env.MINDVAULT_MAX_OBS ?? "50000");
  return Number.isFinite(n) && n > 0 ? n : 50000;
}

export function dream(db: Db, _opts: Record<string, never>): DreamStats {
  const stats: DreamStats = { merged: 0, pruned: 0, cards: 0 };
  stats.merged = mergeDupes(db);
  stats.pruned = decayStale(db) + enforceCap(db, maxObs());
  stats.cards = refreshCards(db);
  db.prepare("INSERT INTO state_meta(key,value) VALUES('last_dream',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(String(Date.now() / 1000));
  return stats;
}

function mergeDupes(db: Db): number {
  const rows = db.prepare("SELECT id, peer_id, scope_id, content, explicit, importance FROM observations ORDER BY id").all() as
    { id: number; peer_id: string; scope_id: number; content: string; explicit: number; importance: number }[];
  const byGroup = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.peer_id}::${r.scope_id}`;
    if (!byGroup.has(k)) byGroup.set(k, []);
    byGroup.get(k)!.push(r);
  }
  let merged = 0;
  const cache = new Map<number, Float32Array>();
  const emb = (r: (typeof rows)[number]): Float32Array => {
    let v = cache.get(r.id);
    if (!v) { v = embOf(r.content); cache.set(r.id, v); }
    return v;
  };
  for (const group of byGroup.values()) {
    const dead = new Set<number>();
    for (let i = 0; i < group.length; i++) {
      if (dead.has(group[i].id)) continue;
      for (let j = i + 1; j < group.length; j++) {
        if (dead.has(group[j].id)) continue;
        if (cos(emb(group[i]), emb(group[j])) < 0.95) continue;
        // survivor: explicit first, then higher importance, then newer (higher id)
        const a = group[i], b = group[j];
        const cmp = (b.explicit - a.explicit) || (b.importance - a.importance) || (b.id - a.id);
        const survivor = cmp >= 0 ? b : a;
        const loser = survivor === a ? b : a;
        db.prepare("UPDATE observations SET supersedes_id=? WHERE id=?").run(loser.id, survivor.id);
        deleteObservationRow(db, loser.id);
        dead.add(loser.id);
        merged++;
      }
    }
  }
  return merged;
}

function deleteObservationRow(db: Db, id: number): void {
  if (vecMode(db) === "vec0") {
    try { db.prepare("DELETE FROM vec_observations WHERE rowid=?").run(id); } catch { /* js */ }
  }
  db.prepare("DELETE FROM observations WHERE id=?").run(id);
}

function decayStale(db: Db, nowSeconds = Date.now() / 1000): number {
  const cutoff = nowSeconds - 30 * 86400;
  const stale = db.prepare(
    `SELECT id FROM observations WHERE mem_type='episodic' AND explicit=0 AND importance < 0.3 AND accesses=0 AND created_at < ? AND scope_id NOT IN (SELECT s.id FROM scopes s WHERE s.key='global')`
  ).all(cutoff) as { id: number }[];
  // global scope exempt (identity facts); procedural exempt by type (not episodic)
  for (const r of stale) deleteObservationRow(db, r.id);
  return stale.length;
}

function enforceCap(db: Db, cap: number, limit = 1000): number {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  if (total <= cap) return 0;
  const excess = Math.min(total - cap, limit);
  const rows = db.prepare(
    `SELECT o.id FROM observations o WHERE o.explicit=0 AND o.scope_id NOT IN (SELECT s.id FROM scopes s WHERE s.key='global')
     ORDER BY o.accesses ASC, o.importance ASC, o.created_at ASC LIMIT ?`
  ).all(excess) as { id: number }[];
  for (const r of rows) deleteObservationRow(db, r.id);
  return rows.length;
}

export function pruneIfOverCap(db: Db): number {
  const cap = maxObs();
  const total = (db.prepare("SELECT COUNT(*) AS n FROM observations").get() as { n: number }).n;
  if (total <= cap) return 0;
  return enforceCap(db, cap);
}

function refreshCards(db: Db): number {
  const pairs = db.prepare("SELECT DISTINCT peer_id, scope_id FROM observations").all() as { peer_id: string; scope_id: number }[];
  const now = Date.now() / 1000;
  for (const p of pairs) {
    const rows = db.prepare("SELECT content FROM observations WHERE peer_id=? AND scope_id=? ORDER BY explicit DESC, importance DESC, id DESC LIMIT 20")
      .all(p.peer_id, p.scope_id) as { content: string }[];
    const card = rows.map((x) => `- ${x.content}`).join("\n").slice(0, 4000);
    db.prepare("INSERT INTO peer_cards(peer_id,scope_id,content,updated_at) VALUES(?,?,?,?) ON CONFLICT(peer_id,scope_id) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at")
      .run(p.peer_id, p.scope_id, card, now);
  }
  return pairs.length;
}
