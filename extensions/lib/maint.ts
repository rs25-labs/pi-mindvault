import type { Db } from "./db.ts";
import { backfillEmbeddings } from "./db.ts";
import { dream } from "./dreamer.ts";

export interface OptimizeReport {
  checkpoint: "ok" | "skipped";
  ftsRebuild: "ok" | "skipped";
  backfilled: number;
  dreamed: { merged: number; pruned: number; cards: number };
  prunedExpired: number;
  vacuum: "ok" | "skipped";
}

export function optimizeNow(db: Db, _opts: Record<string, never>): OptimizeReport {
  const rep: OptimizeReport = { checkpoint: "skipped", ftsRebuild: "skipped", backfilled: 0, dreamed: { merged: 0, pruned: 0, cards: 0 }, prunedExpired: 0, vacuum: "skipped" };
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); rep.checkpoint = "ok"; } catch { /* read-only or no WAL */ }
  try { db.exec("INSERT INTO fts_observations(fts_observations) VALUES('rebuild')"); rep.ftsRebuild = "ok"; } catch { /* FTS degraded */ }
  try { rep.backfilled = backfillEmbeddings(db, 2000); } catch { rep.backfilled = 0; }
  try { rep.dreamed = dream(db, {}); } catch { /* keep report */ }
  try {
    const r = db.prepare("DELETE FROM observations WHERE expiry IS NOT NULL AND expiry < ?").run(Date.now() / 1000) as { changes: number | bigint };
    rep.prunedExpired = Number(r.changes);
  } catch { /* keep */ }
  try { db.exec("VACUUM"); rep.vacuum = "ok"; } catch { /* busy/open transactions */ }
  return rep;
}
