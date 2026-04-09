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

/**
 * Forward-only migrations. Add new statements to the end — never modify existing ones.
 */
function migrate(db: Database.Database): void {
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

  // ── New migrations (append-only) ──────────────────────────────────────────
  // Add sdk_session_id column to sessions table (if it doesn't already exist).
  // We check PRAGMA table_info to avoid errors on re-runs.
  const columns = db
    .prepare("PRAGMA table_info(sessions)")
    .all() as { name: string }[];
  const hasColumn = (name: string) => columns.some((col) => col.name === name);

  if (!hasColumn("sdk_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN sdk_session_id TEXT;");
  }
  if (!hasColumn("provider")) {
    db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT;");
  }
  if (!hasColumn("model")) {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT;");
  }
  if (!hasColumn("agent")) {
    db.exec("ALTER TABLE sessions ADD COLUMN agent TEXT;");
  }
  if (!hasColumn("skills")) {
    db.exec("ALTER TABLE sessions ADD COLUMN skills TEXT;");
  }
  if (!hasColumn("copilot_session_id")) {
    db.exec("ALTER TABLE sessions ADD COLUMN copilot_session_id TEXT;");
  }
  // Records which agent the Copilot SDK session was created with so we can
  // detect agent changes across restarts and force a fresh SDK session.
  if (!hasColumn("copilot_session_agent")) {
    db.exec("ALTER TABLE sessions ADD COLUMN copilot_session_agent TEXT;");
  }

  // Add agent column to messages table to stamp which agent produced each message.
  const msgColumns = db
    .prepare("PRAGMA table_info(messages)")
    .all() as { name: string }[];
  const hasMsgColumn = (name: string) => msgColumns.some((col) => col.name === name);

  if (!hasMsgColumn("agent")) {
    db.exec("ALTER TABLE messages ADD COLUMN agent TEXT;");
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
