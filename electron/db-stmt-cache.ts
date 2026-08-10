import type Database from "better-sqlite3";

type DBInstance = Database.Database;
type Statement = Database.Statement;

/**
 * better-sqlite3 does not cache prepared statements — db.prepare(sql)
 * re-compiles the SQL on every call. The per-turn hot path (saveToolCall,
 * updateToolCallStatus, updateSessionStatus, saveMessage, ...) hits this
 * repeatedly, so callers use stmt(db, sql) instead of db.prepare(sql)
 * directly to get a cached, already-compiled statement.
 *
 * Keyed by Database instance (WeakMap) so tests that open a fresh in-memory
 * DB per test never see a stale statement bound to a closed database, and
 * closed/GC'd databases don't leak cache entries.
 */
const statementCaches = new WeakMap<DBInstance, Map<string, Statement>>();

export function stmt(db: DBInstance, sql: string): Statement {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql);
    cache.set(sql, prepared);
  }
  return prepared;
}
