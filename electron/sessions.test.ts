// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Database } from "better-sqlite3";
import {
  updateSessionStatus,
  recoverStaleSessionStatuses,
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
