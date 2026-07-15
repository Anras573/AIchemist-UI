import Database from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type { Database } from "better-sqlite3";

/**
 * Returns the path to `~/.aichemist/aichemist.db`, creating the directory if needed.
 */
function dbPath(): string {
  const base = path.join(os.homedir(), ".aichemist");
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, "aichemist.db");
}

/** ALTER ... ADD COLUMN only if the column is not already present. */
function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  type: string
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type};`);
  }
}

type Migration = (db: Database.Database) => void;

/**
 * Ordered, numbered migrations gated by `PRAGMA user_version`. Index `i` is
 * schema version `i + 1` and runs exactly once. Each runs inside a transaction
 * together with the `user_version` bump, so a crash can never leave a migration
 * half-applied (SQLite DDL is transactional).
 *
 * APPEND-ONLY: never reorder, delete, or edit an existing entry — only add new
 * ones to the end.
 */
const MIGRATIONS: Migration[] = [
  // v1 — Baseline. These columns were originally added piecemeal by the old
  // "hasColumn + ALTER" loop that ran on every open. Databases created before
  // the numbered-migration system already carry them at user_version 0, so each
  // ADD is guarded by addColumnIfMissing — existing DBs upgrade to v1 without a
  // duplicate-column error, fresh DBs get every column.
  (db) => {
    addColumnIfMissing(db, "sessions", "sdk_session_id", "TEXT");
    addColumnIfMissing(db, "sessions", "provider", "TEXT");
    addColumnIfMissing(db, "sessions", "model", "TEXT");
    addColumnIfMissing(db, "sessions", "branch", "TEXT");
    addColumnIfMissing(db, "sessions", "workspace_path", "TEXT");
    addColumnIfMissing(db, "sessions", "agent", "TEXT");
    addColumnIfMissing(db, "sessions", "skills", "TEXT");
    addColumnIfMissing(db, "sessions", "copilot_session_id", "TEXT");
    addColumnIfMissing(db, "sessions", "copilot_session_agent", "TEXT");
    addColumnIfMissing(db, "sessions", "copilot_session_mcp_fp", "TEXT");
    addColumnIfMissing(db, "sessions", "disabled_mcp_servers", "TEXT");
    addColumnIfMissing(db, "sessions", "github_issue_number", "INTEGER");
    addColumnIfMissing(db, "messages", "agent", "TEXT");
  },
  // v2 — Unified provider session state (issue #56). A single JSON blob per
  // session supersedes sdk_session_id + the copilot_session_* trio (those
  // columns are kept as dead reads for legacy rows). A new provider adds a key
  // to the blob instead of a new column, so this should be the last schema
  // change driven by per-provider session state. Guarded so a DB that somehow
  // already has the column at user_version < 2 (dev build / manual tweak)
  // upgrades instead of throwing a duplicate-column error.
  (db) => {
    addColumnIfMissing(db, "sessions", "provider_state", "TEXT");
  },
  // v3 — Scheduled workflows (issue #90). Adds the `workflows` + `workflow_runs`
  // tables backing the workflow scheduler. A workflow is a saved agent task bound
  // to a project; a workflow_run is one execution of it. `reuse_session_id` and
  // `workflow_runs.session_id` are deliberately FK-free: deleting a session must
  // not cascade-delete a workflow or its run history.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS workflows (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL,
          name             TEXT NOT NULL,
          prompt           TEXT NOT NULL,
          provider         TEXT,
          model            TEXT,
          agent            TEXT,
          skills           TEXT,            -- JSON array of skill names
          cron             TEXT,            -- NULL = manual-only workflow
          enabled          INTEGER NOT NULL DEFAULT 1,
          session_strategy TEXT NOT NULL DEFAULT 'fresh',  -- 'fresh' | 'reuse'
          reuse_session_id TEXT,
          autonomy         TEXT NOT NULL DEFAULT 'interactive',  -- 'interactive' | 'autonomous'
          created_at       TEXT NOT NULL,
          last_run_at      TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
          id          TEXT PRIMARY KEY,
          workflow_id TEXT NOT NULL,
          session_id  TEXT,
          status      TEXT NOT NULL,        -- 'running' | 'success' | 'error' | 'skipped'
          trigger     TEXT NOT NULL,        -- 'cron' | 'manual' | 'file'
          started_at  TEXT NOT NULL,
          ended_at    TEXT,
          error       TEXT,
          FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
      );
    `);
  },
  // v4 — Event-driven (file-watch) workflow triggers (issue #96 part two). Adds
  // `workflows.watch_path`: a filesystem path the scheduler watches; a change
  // under it fires a (debounced) run with trigger 'file'. Nullable and additive —
  // a workflow may declare a cron, a watch_path, both, or neither (manual-only).
  (db) => {
    addColumnIfMissing(db, "workflows", "watch_path", "TEXT");
  },
  // v5 — Usage ledger (issue #156, part of the Spending epic #155). One row per
  // completed turn, normalizing the four token-usage fields already streamed via
  // `TurnEmitter.usage()` into a durable, queryable table. `project_id` is
  // denormalized onto every row (rather than joined through `sessions`) so
  // rollup queries don't need a join. Token counts default to 0 — provider
  // fidelity varies (see epic #155), and a partial/zero reading is valid, not
  // an error. `session_id` is deliberately FK-free (same as
  // `workflow_runs.session_id`) — deleting a session must not cascade-delete
  // the historical spend it incurred, which is the entire point of a durable
  // ledger. Only `project_id` cascades, matching every other per-project table:
  // deleting a whole project already wipes its sessions/messages/tool_calls.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
          id                          TEXT PRIMARY KEY,
          session_id                  TEXT NOT NULL,
          project_id                  TEXT NOT NULL,
          provider                    TEXT NOT NULL,
          model                       TEXT,
          input_tokens                INTEGER NOT NULL DEFAULT 0,
          output_tokens               INTEGER NOT NULL DEFAULT 0,
          cache_read_input_tokens     INTEGER NOT NULL DEFAULT 0,
          cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
          created_at                  TEXT NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_project_created ON usage_ledger(project_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_provider_created ON usage_ledger(provider, created_at);
      CREATE INDEX IF NOT EXISTS idx_usage_ledger_session ON usage_ledger(session_id);
    `);
  },
  // v6 — Usage-ledger backfill (issue #160, part of the Spending epic #155).
  // Adds `usage_ledger.source` so rows reconstructed from a historical trace
  // transcript (backfillUsageLedger in electron/usage-backfill.ts) are
  // distinguishable from rows recorded live at the end of a completed turn
  // (recordUsage(), called from the runner). Existing rows all predate the
  // backfill feature and are live, so the column defaults to 'live' for both
  // pre-existing and new rows that don't pass a source explicitly.
  (db) => {
    addColumnIfMissing(db, "usage_ledger", "source", "TEXT NOT NULL DEFAULT 'live'");
  },
];

/**
 * Create the base schema (idempotent) and run any pending numbered migrations.
 * Exported for tests; production code goes through {@link openDb}.
 */
export function migrate(db: Database.Database): void {
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS projects (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        path       TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title      TEXT NOT NULL DEFAULT 'New session',
        status     TEXT NOT NULL DEFAULT 'idle',
        created_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id         TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
        id         TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        name       TEXT NOT NULL,
        args       TEXT NOT NULL,  -- JSON
        result     TEXT,           -- JSON, NULL until complete
        status     TEXT NOT NULL,
        category   TEXT NOT NULL,
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );
  `);

  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    const apply = db.transaction(() => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1};`);
    });
    apply();
  }
}

/**
 * Open (or create) the database and run all migrations.
 */
export function openDb(): Database.Database {
  const p = dbPath();
  const db = new Database(p);
  migrate(db);
  return db;
}
