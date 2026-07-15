// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./db";
import { backfillUsageLedger } from "./usage-backfill";
import type { TraceSource } from "./trace-source";
import type { TraceSpan } from "../src/types/index";

const resolveTraceSourceMock = vi.fn<(db: unknown, sessionId: string) => TraceSource>();
const loadTranscriptSpansMock = vi.fn<(db: unknown, sessionId: string) => Promise<TraceSpan[]>>();

vi.mock("./trace-source", () => ({
  resolveTraceSource: (...args: unknown[]) => resolveTraceSourceMock(...(args as [unknown, string])),
  loadTranscriptSpans: (...args: unknown[]) => loadTranscriptSpansMock(...(args as [unknown, string])),
}));

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

function turnSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
  return {
    id: "turn:1",
    sessionId: "sess-1",
    type: "turn",
    name: "Agent Turn",
    startMs: 1_700_000_000_000,
    endMs: 1_700_000_010_000,
    status: "success",
    meta: { model: "claude-sonnet-4-6", tokens: { input: 100, output: 50, cacheRead: 10, cacheCreation: 5 } },
    ...overrides,
  };
}

function ledgerRows(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM usage_ledger ORDER BY session_id").all() as Array<
    Record<string, unknown>
  >;
}

let db: Database.Database;
beforeEach(() => {
  db = makeDb();
  seedProject(db, "proj-1");
  seedProject(db, "proj-2");
  seedSession(db, "sess-1", "proj-1");
  seedSession(db, "sess-2", "proj-1");
  seedSession(db, "sess-3", "proj-2");
  resolveTraceSourceMock.mockReset();
  loadTranscriptSpansMock.mockReset();
});

// ─── backfillUsageLedger ───────────────────────────────────────────────────────

describe("backfillUsageLedger", () => {
  it("backfills a session's completed turns as 'backfill' rows with the resolved provider", async () => {
    resolveTraceSourceMock.mockImplementation((_db, sessionId) =>
      sessionId === "sess-1"
        ? { kind: "claude", projectPath: "/tmp/proj-1", sdkSessionId: "sdk-1", provider: "anthropic" }
        : null
    );
    loadTranscriptSpansMock.mockImplementation(async (_db, sessionId) =>
      sessionId === "sess-1" ? [turnSpan()] : []
    );

    const result = await backfillUsageLedger(db);

    const sess1 = result.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1).toMatchObject({ status: "backfilled", turnsBackfilled: 1 });
    expect(result.totalTurnsBackfilled).toBe(1);

    const rows = ledgerRows(db).filter((r) => r.session_id === "sess-1");
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
      source: "backfill",
      created_at: new Date(1_700_000_010_000).toISOString(),
    });
  });

  it("skips a session that already has usage_ledger rows, without re-parsing its transcript", async () => {
    db.prepare(
      `INSERT INTO usage_ledger (id, session_id, project_id, provider, created_at) VALUES ('u1', 'sess-1', 'proj-1', 'anthropic', 'now')`
    ).run();

    const result = await backfillUsageLedger(db, { projectId: "proj-1" });

    const sess1 = result.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1).toMatchObject({ status: "skipped-has-usage", turnsBackfilled: 0 });
    expect(loadTranscriptSpansMock).not.toHaveBeenCalledWith(expect.anything(), "sess-1");
  });

  it("skips a session with no resolvable trace source", async () => {
    resolveTraceSourceMock.mockReturnValue(null);

    const result = await backfillUsageLedger(db, { projectId: "proj-1" });

    for (const s of result.sessions) {
      expect(s).toMatchObject({ status: "skipped-no-transcript", turnsBackfilled: 0 });
    }
    expect(result.totalTurnsBackfilled).toBe(0);
  });

  it("skips a session whose transcript has no completed turns (still running, or empty)", async () => {
    resolveTraceSourceMock.mockReturnValue({
      kind: "native",
      sessionId: "sess-1",
      provider: "ollama",
    });
    loadTranscriptSpansMock.mockImplementation(async (_db, sessionId) =>
      sessionId === "sess-1" ? [turnSpan({ status: "running", endMs: undefined })] : []
    );

    const result = await backfillUsageLedger(db, { projectId: "proj-1" });

    const sess1 = result.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1).toMatchObject({ status: "skipped-no-transcript", turnsBackfilled: 0 });
    expect(ledgerRows(db)).toHaveLength(0);
  });

  it("defaults tokens to 0 and model to null when a completed turn has no usage/model recorded", async () => {
    resolveTraceSourceMock.mockReturnValue({
      kind: "copilot",
      copilotSessionId: "cop-1",
      provider: "copilot",
    });
    loadTranscriptSpansMock.mockImplementation(async (_db, sessionId) =>
      sessionId === "sess-1" ? [turnSpan({ meta: {} })] : []
    );

    await backfillUsageLedger(db, { projectId: "proj-1" });

    const row = ledgerRows(db).find((r) => r.session_id === "sess-1")!;
    expect(row).toMatchObject({
      provider: "copilot",
      model: null,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
  });

  it("is idempotent — running it twice does not duplicate rows", async () => {
    resolveTraceSourceMock.mockImplementation((_db, sessionId) =>
      sessionId === "sess-1"
        ? { kind: "native", sessionId: "sess-1", provider: "ollama" }
        : null
    );
    loadTranscriptSpansMock.mockImplementation(async (_db, sessionId) =>
      sessionId === "sess-1" ? [turnSpan(), turnSpan({ id: "turn:2" })] : []
    );

    const first = await backfillUsageLedger(db, { projectId: "proj-1" });
    expect(first.totalTurnsBackfilled).toBe(2);
    expect(ledgerRows(db).filter((r) => r.session_id === "sess-1")).toHaveLength(2);

    const second = await backfillUsageLedger(db, { projectId: "proj-1" });
    const sess1Second = second.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1Second).toMatchObject({ status: "skipped-has-usage", turnsBackfilled: 0 });
    expect(ledgerRows(db).filter((r) => r.session_id === "sess-1")).toHaveLength(2);
  });

  it("is fail-safe per session — one session erroring doesn't abort the rest", async () => {
    resolveTraceSourceMock.mockImplementation((_db, sessionId) => {
      if (sessionId === "sess-1") throw new Error("corrupt provider_state");
      if (sessionId === "sess-2") return { kind: "native", sessionId: "sess-2", provider: "ollama" };
      return null;
    });
    loadTranscriptSpansMock.mockImplementation(async (_db, sessionId) =>
      sessionId === "sess-2" ? [turnSpan({ id: "turn:2", sessionId: "sess-2" })] : []
    );

    const result = await backfillUsageLedger(db, { projectId: "proj-1" });

    const sess1 = result.sessions.find((s) => s.sessionId === "sess-1");
    expect(sess1?.status).toBe("error");
    expect(sess1?.error).toContain("corrupt provider_state");
    const sess2 = result.sessions.find((s) => s.sessionId === "sess-2");
    expect(sess2).toMatchObject({ status: "backfilled", turnsBackfilled: 1 });
  });

  it("scopes to opts.projectId when provided", async () => {
    resolveTraceSourceMock.mockReturnValue(null);

    const result = await backfillUsageLedger(db, { projectId: "proj-2" });

    expect(result.sessions.map((s) => s.sessionId)).toEqual(["sess-3"]);
  });
});
