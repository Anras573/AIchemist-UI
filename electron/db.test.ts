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

describe("migrate", () => {
  it("brings a fresh database to the latest version with every column", () => {
    const db = new Database(":memory:");
    migrate(db);

    expect(userVersion(db)).toBe(2);
    const cols = columnNames(db, "sessions");
    for (const c of EXPECTED_SESSION_COLUMNS) {
      expect(cols).toContain(c);
    }
    expect(columnNames(db, "messages")).toContain("agent");
  });

  it("is idempotent — running twice does not error or change the version", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db)).not.toThrow();
    expect(userVersion(db)).toBe(2);
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

    expect(userVersion(db)).toBe(2);
    expect(columnNames(db, "sessions")).toContain("provider_state");
    // Existing data is preserved, including the legacy copilot id used as a dead read.
    const row = db.prepare("SELECT copilot_session_id, provider_state FROM sessions WHERE id = ?").get("s1") as {
      copilot_session_id: string | null;
      provider_state: string | null;
    };
    expect(row.copilot_session_id).toBe("legacy-copilot-id");
    expect(row.provider_state).toBeNull();
  });
});
