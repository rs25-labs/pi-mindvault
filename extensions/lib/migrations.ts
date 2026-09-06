import type { Db } from "./db.ts";

export interface Migration { version: number; up(db: Db): void }

function hasColumn(db: Db, table: string, col: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    up(db) {
      if (!hasColumn(db, "observations", "embedding")) db.exec("ALTER TABLE observations ADD COLUMN embedding BLOB");
    },
  },
  {
    version: 3,
    up(db) {
      if (!hasColumn(db, "messages", "observed")) db.exec("ALTER TABLE messages ADD COLUMN observed INTEGER NOT NULL DEFAULT 0");
    },
  },
  {
    version: 4,
    up(db) {
      if (!hasColumn(db, "recall_log", "used_ids_json")) db.exec("ALTER TABLE recall_log ADD COLUMN used_ids_json TEXT");
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 1);

export function runMigrations(db: Db): void {
  const row = db.prepare("SELECT value FROM state_meta WHERE key='schema_version'").get() as { value?: string } | undefined;
  if (!row) {
    db.prepare("INSERT INTO state_meta(key,value) VALUES('schema_version',?)").run(String(LATEST_SCHEMA_VERSION));
    return;
  }
  let current = Number(row.value) || 1;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      m.up(db);
      db.prepare("UPDATE state_meta SET value=? WHERE key='schema_version'").run(String(m.version));
      db.exec("COMMIT");
      current = m.version;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
}
