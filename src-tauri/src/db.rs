use rusqlite::{Connection, Result};
use std::path::PathBuf;

/// Returns the path to `~/.aichemist/aichemist.db`, creating the directory if needed.
pub fn db_path() -> PathBuf {
    let base = dirs_next::home_dir()
        .expect("cannot determine home directory")
        .join(".aichemist");
    std::fs::create_dir_all(&base).expect("cannot create ~/.aichemist");
    base.join("aichemist.db")
}

/// Open (or create) the database and run all migrations.
pub fn open() -> Result<Connection> {
    let path = db_path();
    let conn = Connection::open(path)?;
    migrate(&conn)?;
    Ok(conn)
}

/// Forward-only migrations. Add new statements to the end — never modify existing ones.
fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch("
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
    ")
}
