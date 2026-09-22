// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import RealDatabase from "better-sqlite3";
import type { Database } from "better-sqlite3";
import { migrate } from "./db";
import {
  createSession,
  updateSessionStatus,
  recoverStaleSessionStatuses,
  getSession,
  DEFAULT_MESSAGE_PAGE_SIZE,
} from "./sessions";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Creates a minimal mock of the better-sqlite3 Database interface.
 * `prepare(sql)` returns a statement stub; `mockRun` / `mockGet` capture calls.
 */
function makeDb(runResult = { changes: 0 }) {
  const mockRun = vi.fn().mockReturnValue(runResult);
  const mockGet = vi.fn().mockReturnValue(undefined);
  const db = {
    prepare: vi.fn().mockReturnValue({ run: mockRun, get: mockGet }),
  } as unknown as Database;
  return { db, mockRun, mockGet };
}

// ─── updateSessionStatus ─────────────────────────────────────────────────────

describe("updateSessionStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prepares the correct UPDATE statement", () => {
    const { db, mockRun } = makeDb();
    updateSessionStatus(db, "sess-1", "running");

    expect(db.prepare).toHaveBeenCalledWith(
      "UPDATE sessions SET status = ? WHERE id = ?"
    );
    expect(mockRun).toHaveBeenCalledWith("running", "sess-1");
  });

  it("passes the given status value to the statement", () => {
    const { db, mockRun } = makeDb();
    updateSessionStatus(db, "sess-1", "error");
    expect(mockRun).toHaveBeenCalledWith("error", "sess-1");
  });

  it("passes 'idle' status correctly", () => {
    const { db, mockRun } = makeDb();
    updateSessionStatus(db, "sess-abc", "idle");
    expect(mockRun).toHaveBeenCalledWith("idle", "sess-abc");
  });
});

// ─── recoverStaleSessionStatuses ─────────────────────────────────────────────

describe("recoverStaleSessionStatuses", () => {
  beforeEach(() => vi.clearAllMocks());

  it("targets only 'running' sessions with a hard-coded status update", () => {
    const { db } = makeDb({ changes: 0 });
    recoverStaleSessionStatuses(db);

    const sql = vi.mocked(db.prepare).mock.calls[0][0];
    expect(sql).toMatch(/UPDATE sessions SET status = 'error' WHERE status = 'running'/i);
  });

  it("returns the number of sessions recovered (changes)", () => {
    const { db } = makeDb({ changes: 3 });
    expect(recoverStaleSessionStatuses(db)).toBe(3);
  });

  it("returns 0 when no sessions were running", () => {
    const { db } = makeDb({ changes: 0 });
    expect(recoverStaleSessionStatuses(db)).toBe(0);
  });
});

// ─── createSession ─────────────────────────────────────────────────────────────

describe("createSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("persists branch and workspace path when provided", () => {
    const { db, mockRun } = makeDb();
    const session = createSession(db, "proj-1", "anthropic", "claude-sonnet-4-6", {
      id: "sess-1",
      branch: "aichemist/sess-1",
      workspacePath: "/tmp/aichemist-sess-1",
    });

    expect(session.branch).toBe("aichemist/sess-1");
    expect(session.workspace_path).toBe("/tmp/aichemist-sess-1");
    expect(mockRun).toHaveBeenCalledWith(
      "sess-1",
      "proj-1",
      expect.any(String),
      "anthropic",
      "claude-sonnet-4-6",
      "aichemist/sess-1",
      "/tmp/aichemist-sess-1",
      null
    );
  });

  it("stores github_issue_number when provided in options", () => {
    const { db, mockRun } = makeDb();
    createSession(db, "proj-1", "anthropic", "claude-sonnet-4-6", {
      id: "sess-2",
      issueNumber: 19,
    });

    expect(mockRun).toHaveBeenCalledWith(
      "sess-2",
      "proj-1",
      expect.any(String),
      "anthropic",
      "claude-sonnet-4-6",
      null,
      null,
      19
    );
  });
});

// ─── Disabled MCP helpers ────────────────────────────────────────────────────

import { getDisabledMcpServers, setDisabledMcpServers } from "./sessions";

describe("getDisabledMcpServers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns [] when row is missing", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce(undefined);
    expect(getDisabledMcpServers(db, "s1")).toEqual([]);
  });

  it("returns [] when stored value is null", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce({ disabled_mcp_servers: null });
    expect(getDisabledMcpServers(db, "s1")).toEqual([]);
  });

  it("parses a JSON array of strings", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce({ disabled_mcp_servers: '["a","b"]' });
    expect(getDisabledMcpServers(db, "s1")).toEqual(["a", "b"]);
  });

  it("returns [] for malformed JSON instead of throwing", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce({ disabled_mcp_servers: "{not json" });
    expect(getDisabledMcpServers(db, "s1")).toEqual([]);
  });

  it("filters out non-string array entries", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce({ disabled_mcp_servers: '["a", 5, null, "b"]' });
    expect(getDisabledMcpServers(db, "s1")).toEqual(["a", "b"]);
  });

  it("returns [] for non-array JSON (e.g. object)", () => {
    const { db, mockGet } = makeDb();
    mockGet.mockReturnValueOnce({ disabled_mcp_servers: '{"a":1}' });
    expect(getDisabledMcpServers(db, "s1")).toEqual([]);
  });
});

describe("setDisabledMcpServers", () => {
  beforeEach(() => vi.clearAllMocks());

  it("dedupes, sorts, and stores as JSON", () => {
    const { db, mockRun } = makeDb();
    setDisabledMcpServers(db, "s1", ["zeta", "alpha", "alpha", "beta"]);
    expect(mockRun).toHaveBeenCalledWith('["alpha","beta","zeta"]', "s1");
  });

  it("stores NULL for empty array", () => {
    const { db, mockRun } = makeDb();
    setDisabledMcpServers(db, "s1", []);
    expect(mockRun).toHaveBeenCalledWith(null, "s1");
  });

  it("filters out non-string and empty entries", () => {
    const { db, mockRun } = makeDb();
    // @ts-expect-error — exercising defensive runtime check
    setDisabledMcpServers(db, "s1", ["ok", "", null, undefined, 5]);
    expect(mockRun).toHaveBeenCalledWith('["ok"]', "s1");
  });
});

// ─── getSession pagination ───────────────────────────────────────────────────
//
// Uses a real in-memory better-sqlite3 database (rather than the mocked
// prepare()/run() stub above) since the paginated branch depends on real
// rowid ordering and LIMIT semantics that a mock can't meaningfully exercise.

function makeRealDb(): Database {
  const db = new RealDatabase(":memory:");
  migrate(db);
  return db;
}

function seedProject(db: Database, id: string): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    id,
    `/tmp/${id}`,
    new Date().toISOString()
  );
}

function seedSession(db: Database, id: string, projectId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)"
  ).run(id, projectId, new Date().toISOString());
}

/** Inserts `count` messages (ids "m0".."m{count-1}") in insertion order, oldest first. */
function seedMessages(db: Database, sessionId: string, count: number): void {
  const insert = db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at, agent) VALUES (?, ?, 'user', ?, ?, NULL)"
  );
  for (let i = 0; i < count; i++) {
    // Distinct, monotonically increasing timestamps so ASC ordering is unambiguous.
    insert.run(`m${i}`, sessionId, `content ${i}`, new Date(2024, 0, 1, 0, 0, i).toISOString());
  }
}

describe("getSession — pagination", () => {
  it("with no options, returns full history ordered oldest-first and has_more_messages: false", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 5);

    const session = getSession(db, "s1");

    expect(session.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
    expect(session.has_more_messages).toBe(false);
  });

  it("with limit alone, returns the most recent page (oldest-first) and flags more when they exist", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 5);

    const session = getSession(db, "s1", { limit: 2 });

    // Most recent 2 messages, still returned oldest-first.
    expect(session.messages.map((m) => m.id)).toEqual(["m3", "m4"]);
    expect(session.has_more_messages).toBe(true);
  });

  it("with limit covering the full history, reports has_more_messages: false", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 3);

    const session = getSession(db, "s1", { limit: 10 });

    expect(session.messages.map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
    expect(session.has_more_messages).toBe(false);
  });

  it("with beforeMessageId, returns the page immediately older than the cursor", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 6); // m0..m5

    // Oldest currently-loaded message is m3 — ask for the 2 before it.
    const session = getSession(db, "s1", { limit: 2, beforeMessageId: "m3" });

    expect(session.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(session.has_more_messages).toBe(true);
  });

  it("with beforeMessageId reaching the start of history, reports has_more_messages: false", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 6); // m0..m5

    const session = getSession(db, "s1", { limit: 2, beforeMessageId: "m1" });

    expect(session.messages.map((m) => m.id)).toEqual(["m0"]);
    expect(session.has_more_messages).toBe(false);
  });

  it("with a stale beforeMessageId (message no longer exists), returns no messages instead of re-fetching the newest page", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 5);

    const session = getSession(db, "s1", { limit: 2, beforeMessageId: "does-not-exist" });

    expect(session.messages).toEqual([]);
    expect(session.has_more_messages).toBe(false);
  });

  it("defaults the page size to DEFAULT_MESSAGE_PAGE_SIZE when beforeMessageId is given without limit", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", DEFAULT_MESSAGE_PAGE_SIZE + 10);

    const cursorId = `m${DEFAULT_MESSAGE_PAGE_SIZE}`; // the (DEFAULT_MESSAGE_PAGE_SIZE)-th message, 0-indexed
    const session = getSession(db, "s1", { beforeMessageId: cursorId });

    expect(session.messages).toHaveLength(DEFAULT_MESSAGE_PAGE_SIZE);
    expect(session.messages[session.messages.length - 1].id).toBe(
      `m${DEFAULT_MESSAGE_PAGE_SIZE - 1}`
    );
    expect(session.has_more_messages).toBe(false);
  });

  it("attaches tool_calls to messages in a paginated page", () => {
    const db = makeRealDb();
    seedProject(db, "p1");
    seedSession(db, "s1", "p1");
    seedMessages(db, "s1", 3);
    db.prepare(
      "INSERT INTO tool_calls (id, message_id, name, args, result, status, category) VALUES (?, ?, ?, ?, NULL, 'complete', 'read')"
    ).run("tc-1", "m2", "read_file", JSON.stringify({ path: "a.txt" }));

    const session = getSession(db, "s1", { limit: 2 });

    const m2 = session.messages.find((m) => m.id === "m2");
    expect(m2?.tool_calls).toHaveLength(1);
    expect(m2?.tool_calls[0].name).toBe("read_file");
  });

  it("throws for an unknown session id regardless of pagination options", () => {
    const db = makeRealDb();
    expect(() => getSession(db, "missing", { limit: 5 })).toThrow(/Session not found/);
  });
});
