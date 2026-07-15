// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./db";
import {
  recordUsage,
  getUsageTotals,
  getUsageByProvider,
  getUsageByProject,
  getUsageBySession,
  getUsageByDay,
  getUsageByProviderModel,
} from "./usage-ledger";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function seedProject(db: Database.Database, id: string): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    id,
    `/tmp/${id}`,
    new Date().toISOString()
  );
}

function seedSession(db: Database.Database, id: string, projectId: string): void {
  db.prepare(
    "INSERT INTO sessions (id, project_id, title, status, created_at) VALUES (?, ?, 'S', 'idle', ?)"
  ).run(id, projectId, new Date().toISOString());
}

const USAGE = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_input_tokens: 10,
  cache_creation_input_tokens: 5,
};

let db: Database.Database;
beforeEach(() => {
  db = makeDb();
  seedProject(db, "proj-1");
  seedProject(db, "proj-2");
  seedSession(db, "sess-1", "proj-1");
  seedSession(db, "sess-2", "proj-1");
  seedSession(db, "sess-3", "proj-2");
});

// ─── recordUsage ─────────────────────────────────────────────────────────────

describe("recordUsage", () => {
  it("inserts one row per call with the given fields mapped correctly", () => {
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: USAGE,
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const rows = db.prepare("SELECT * FROM usage_ledger").all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      session_id: "sess-1",
      project_id: "proj-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      created_at: "2026-07-01T00:00:00.000Z",
    });
    expect(typeof rows[0].id).toBe("string");
    expect(rows[0].source).toBe("live");
  });

  it("records an explicit source (e.g. 'backfill')", () => {
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      usage: USAGE,
      source: "backfill",
    });

    const row = db.prepare("SELECT source FROM usage_ledger").get() as { source: string };
    expect(row.source).toBe("backfill");
  });

  it("allows a null model and zero token fields (partial provider fidelity)", () => {
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "ollama",
      model: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });

    const row = db.prepare("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.model).toBeNull();
    expect(row.input_tokens).toBe(0);
  });

  it("trims a whitespace-only model to null, regardless of caller normalization", () => {
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "ollama",
      model: "   ",
      usage: USAGE,
    });

    const row = db.prepare("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.model).toBeNull();
  });

  it("trims surrounding whitespace from a real model string", () => {
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "  claude-sonnet-4-6  ",
      usage: USAGE,
    });

    const row = db.prepare("SELECT * FROM usage_ledger").get() as Record<string, unknown>;
    expect(row.model).toBe("claude-sonnet-4-6");
  });

  it("writes a separate row for each call, even on the same session", () => {
    recordUsage(db, { sessionId: "sess-1", projectId: "proj-1", provider: "anthropic", model: "m", usage: USAGE });
    recordUsage(db, { sessionId: "sess-1", projectId: "proj-1", provider: "anthropic", model: "m", usage: USAGE });

    const count = (db.prepare("SELECT COUNT(*) AS c FROM usage_ledger").get() as { c: number }).c;
    expect(count).toBe(2);
  });
});

// ─── Durability across session/project deletion ─────────────────────────────

describe("durability", () => {
  it("survives session deletion — session_id is deliberately FK-free", () => {
    recordUsage(db, { sessionId: "sess-1", projectId: "proj-1", provider: "anthropic", model: "m", usage: USAGE });

    db.prepare("DELETE FROM sessions WHERE id = ?").run("sess-1");

    const rows = db.prepare("SELECT * FROM usage_ledger").all();
    expect(rows).toHaveLength(1);
    expect(getUsageTotals(db, { projectId: "proj-1" }).turn_count).toBe(1);
  });

  it("is cascade-deleted when its project is deleted", () => {
    recordUsage(db, { sessionId: "sess-1", projectId: "proj-1", provider: "anthropic", model: "m", usage: USAGE });

    db.prepare("DELETE FROM projects WHERE id = ?").run("proj-1");

    const rows = db.prepare("SELECT * FROM usage_ledger").all();
    expect(rows).toHaveLength(0);
  });
});

// ─── Aggregation queries ─────────────────────────────────────────────────────

describe("aggregation queries", () => {
  beforeEach(() => {
    // proj-1 / sess-1 / anthropic — day 1
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude",
      usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    // proj-1 / sess-2 / copilot — day 1
    recordUsage(db, {
      sessionId: "sess-2",
      projectId: "proj-1",
      provider: "copilot",
      model: null,
      usage: { input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      createdAt: "2026-07-01T12:00:00.000Z",
    });
    // proj-2 / sess-3 / anthropic — day 2
    recordUsage(db, {
      sessionId: "sess-3",
      projectId: "proj-2",
      provider: "anthropic",
      model: "claude",
      usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      createdAt: "2026-07-02T09:00:00.000Z",
    });
  });

  it("getUsageTotals sums every field across all rows with no filter", () => {
    const totals = getUsageTotals(db);
    expect(totals).toEqual({
      input_tokens: 300,
      output_tokens: 110,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      turn_count: 3,
    });
  });

  it("getUsageTotals returns all-zero totals with no matching rows", () => {
    const totals = getUsageTotals(db, { projectId: "no-such-project" });
    expect(totals).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      turn_count: 0,
    });
  });

  it("getUsageTotals filters by projectId", () => {
    const totals = getUsageTotals(db, { projectId: "proj-1" });
    expect(totals).toEqual({
      input_tokens: 100,
      output_tokens: 70,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      turn_count: 2,
    });
  });

  it("getUsageTotals filters by provider", () => {
    const totals = getUsageTotals(db, { provider: "anthropic" });
    expect(totals.turn_count).toBe(2);
    expect(totals.input_tokens).toBe(300);
  });

  it("getUsageTotals filters by an arbitrary time window (since/until)", () => {
    // Only the day-1 rows (before 2026-07-02).
    const totals = getUsageTotals(db, { since: "2026-07-01T00:00:00.000Z", until: "2026-07-02T00:00:00.000Z" });
    expect(totals.turn_count).toBe(2);
    expect(totals.output_tokens).toBe(70);
  });

  it("getUsageByProvider groups totals per provider, sorted", () => {
    const rows = getUsageByProvider(db);
    expect(rows).toEqual([
      { provider: "anthropic", input_tokens: 300, output_tokens: 90, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, turn_count: 2 },
      { provider: "copilot", input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
    ]);
  });

  it("getUsageByProject groups totals per project", () => {
    const rows = getUsageByProject(db);
    expect(rows).toEqual([
      { project_id: "proj-1", input_tokens: 100, output_tokens: 70, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, turn_count: 2 },
      { project_id: "proj-2", input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
    ]);
  });

  it("getUsageBySession groups totals per session", () => {
    const rows = getUsageBySession(db, { projectId: "proj-1" });
    expect(rows).toEqual([
      { session_id: "sess-1", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, turn_count: 1 },
      { session_id: "sess-2", input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
    ]);
  });

  it("getUsageByDay groups totals across the day boundary", () => {
    const rows = getUsageByDay(db);
    expect(rows).toEqual([
      { day: "2026-07-01", input_tokens: 100, output_tokens: 70, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, turn_count: 2 },
      { day: "2026-07-02", input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
    ]);
  });

  it("getUsageByProviderModel groups totals per provider+model, sorted", () => {
    // Add a second anthropic model in proj-1 so the group-by is exercised.
    recordUsage(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "anthropic",
      model: "claude-haiku",
      usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      createdAt: "2026-07-01T11:00:00.000Z",
    });

    const rows = getUsageByProviderModel(db, { projectId: "proj-1" });
    expect(rows).toEqual([
      { provider: "anthropic", model: "claude", input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, turn_count: 1 },
      { provider: "anthropic", model: "claude-haiku", input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
      { provider: "copilot", model: null, input_tokens: 0, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, turn_count: 1 },
    ]);
  });

  it("composes multiple filters together (project + provider + time window)", () => {
    const totals = getUsageTotals(db, {
      projectId: "proj-1",
      provider: "anthropic",
      since: "2026-07-01T00:00:00.000Z",
      until: "2026-07-02T00:00:00.000Z",
    });
    expect(totals).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      turn_count: 1,
    });
  });
});
