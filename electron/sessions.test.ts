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
