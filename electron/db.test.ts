// @vitest-environment node
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./db";

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
    (c) => c.name
  );
}

const EXPECTED_SESSION_COLUMNS = [
  "sdk_session_id",
  "provider",
  "model",
  "branch",
  "workspace_path",
  "agent",
  "skills",
  "copilot_session_id",
  "copilot_session_agent",
  "copilot_session_mcp_fp",
  "disabled_mcp_servers",
  "github_issue_number",
  "provider_state",
];

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
  ).map((t) => t.name);
}

function indexNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as { name: string }[]).map(
    (i) => i.name
  );
}

describe("migrate", () => {
  it("brings a fresh database to the latest version with every column", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(userVersion(db)).toBe(8);
    const cols = columnNames(db, "sessions");
    for (const c of EXPECTED_SESSION_COLUMNS) {
      expect(cols).toContain(c);
    }
    expect(columnNames(db, "messages")).toContain("agent");
  });

  it("creates the usage_ledger table at v5", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(tableNames(db)).toContain("usage_ledger");
    for (const c of [
      "session_id",
      "project_id",
      "provider",
      "model",
      "input_tokens",
      "output_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "created_at",
    ]) {
      expect(columnNames(db, "usage_ledger")).toContain(c);
    }
  });

  it("adds usage_ledger.source at v6, defaulting existing + new rows to 'live'", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(columnNames(db, "usage_ledger")).toContain("source");
    db.prepare(
      `INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')`
    ).run();
    db.prepare(
      `INSERT INTO sessions (id, project_id, title, status, created_at) VALUES ('s1', 'p1', 'S', 'idle', 'now')`
    ).run();
    db.prepare(
      `INSERT INTO usage_ledger (id, session_id, project_id, provider, created_at) VALUES ('u1', 's1', 'p1', 'anthropic', 'now')`
    ).run();
    const row = db.prepare("SELECT source FROM usage_ledger WHERE id = 'u1'").get() as { source: string };
    expect(row.source).toBe("live");
  });

  it("creates the workflows + workflow_runs tables at v3", () => {
    const db = new Database(":memory:");
    migrate(db);

    const tables = tableNames(db);
    expect(tables).toContain("workflows");
    expect(tables).toContain("workflow_runs");

    for (const c of [
      "project_id",
      "prompt",
      "cron",
      "watch_path",
      "enabled",
      "session_strategy",
      "reuse_session_id",
      "autonomy",
      "last_run_at",
    ]) {
      expect(columnNames(db, "workflows")).toContain(c);
    }
    for (const c of ["workflow_id", "status", "trigger", "started_at", "ended_at", "error"]) {
      expect(columnNames(db, "workflow_runs")).toContain(c);
    }
  });

  it("creates the canvases, session_canvases, and canvas_trust tables at v8", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(userVersion(db)).toBe(8);
    const tables = tableNames(db);
    expect(tables).toContain("canvases");
    expect(tables).toContain("session_canvases");
    expect(tables).toContain("canvas_trust");

    for (const c of ["project_id", "definition", "title", "state", "revision", "created_at", "updated_at"]) {
      expect(columnNames(db, "canvases")).toContain(c);
    }
    expect(columnNames(db, "session_canvases")).toEqual(
      expect.arrayContaining(["session_id", "canvas_id"])
    );
    for (const c of ["project_id", "definition", "content_hash", "trusted_at"]) {
      expect(columnNames(db, "canvas_trust")).toContain(c);
    }
    expect(columnNames(db, "messages")).toContain("source");
  });

  it("cascades project/session deletes onto canvases the same way as other project-scoped tables", () => {
    const db = new Database(":memory:");
    migrate(db);

    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();
    db.prepare(
      "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES ('s1', 'p1', 'S', 'idle', 'now')"
    ).run();
    db.prepare(
      "INSERT INTO canvases (id, project_id, definition, title, state, revision, created_at, updated_at) VALUES ('c1', 'p1', 'kanban', 'Board', 'null', 0, 'now', 'now')"
    ).run();
    db.prepare("INSERT INTO session_canvases (session_id, canvas_id) VALUES ('s1', 'c1')").run();
    db.prepare(
      "INSERT INTO canvas_trust (project_id, definition, content_hash, trusted_at) VALUES ('p1', 'kanban', 'hash1', 'now')"
    ).run();

    // Deleting the session only removes its attachment, not the canvas.
    db.prepare("DELETE FROM sessions WHERE id = 's1'").run();
    expect(db.prepare("SELECT * FROM session_canvases").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM canvases WHERE id = 'c1'").get()).toBeDefined();

    // Deleting the project cascades the canvas and its trust record.
    db.prepare("DELETE FROM projects WHERE id = 'p1'").run();
    expect(db.prepare("SELECT * FROM canvases").all()).toHaveLength(0);
    expect(db.prepare("SELECT * FROM canvas_trust").all()).toHaveLength(0);
  });

  it("is idempotent — running twice does not error or change the version", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(8);
  });

  it("does not throw when provider_state already exists below user_version 2", () => {
    const db = new Database(":memory:");
    migrate(db); // brings it to the latest version with provider_state present
    // Simulate a dev build / partial migration: column exists but version rewound.
    db.exec("PRAGMA user_version = 1;");
    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(8);
  });

  it("upgrades a legacy database (columns present, user_version 0) without error", () => {
    const db = new Database(":memory:");
    // Simulate the pre-issue-56 schema produced by the old hasColumn ALTER loop:
    // every column except provider_state already exists, and user_version is 0.
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, path TEXT UNIQUE, created_at TEXT);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT, created_at TEXT,
        sdk_session_id TEXT, provider TEXT, model TEXT, branch TEXT, workspace_path TEXT,
        agent TEXT, skills TEXT, copilot_session_id TEXT, copilot_session_agent TEXT,
        copilot_session_mcp_fp TEXT, disabled_mcp_servers TEXT, github_issue_number INTEGER
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, created_at TEXT, agent TEXT);
      CREATE TABLE tool_calls (id TEXT PRIMARY KEY, message_id TEXT, name TEXT, args TEXT, result TEXT, status TEXT, category TEXT);
    `);
    db.prepare(
      "INSERT INTO sessions (id, project_id, title, status, created_at, copilot_session_id) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("s1", "p1", "t", "idle", "now", "legacy-copilot-id");
    expect(userVersion(db)).toBe(0);

    expect(() => migrate(db)).not.toThrow();

    expect(userVersion(db)).toBe(8);
    expect(columnNames(db, "sessions")).toContain("provider_state");
    expect(tableNames(db)).toContain("workflows");
    // Existing data is preserved, including the legacy copilot id used as a dead read.
    const row = db.prepare("SELECT copilot_session_id, provider_state FROM sessions WHERE id = ?").get("s1") as {
      copilot_session_id: string | null;
      provider_state: string | null;
    };
    expect(row.copilot_session_id).toBe("legacy-copilot-id");
    expect(row.provider_state).toBeNull();
  });

  it("adds indexes on the hot foreign keys (messages, tool_calls, sessions) at v7", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(indexNames(db, "messages")).toContain("idx_messages_session");
    expect(indexNames(db, "tool_calls")).toContain("idx_tool_calls_message");
    expect(indexNames(db, "sessions")).toContain("idx_sessions_project");
  });

  it("sets synchronous=NORMAL alongside WAL", () => {
    const db = new Database(":memory:");
    migrate(db);

    // better-sqlite3 reports synchronous as an integer: 0=OFF, 1=NORMAL, 2=FULL, 3=EXTRA.
    expect(db.pragma("synchronous", { simple: true })).toBe(1);
  });
});
