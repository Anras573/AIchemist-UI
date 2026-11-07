import { describe, it, expect, vi, beforeEach } from "vitest";

const { queryMock, canvasServersMock, canvasAddendumMock, managedMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  canvasServersMock: vi.fn(() => ({})),
  canvasAddendumMock: vi.fn(() => ""),
  managedMock: vi.fn(() => ({})),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: queryMock }));
vi.mock("./mcp-tools", () => ({
  createApprovalMcpServer: vi.fn(async () => ({ type: "sdk", name: "aichemist-tools" })),
}));
vi.mock("../canvas/mcp-endpoint", () => ({
  canvasMcpServersForSession: canvasServersMock,
  buildCanvasSystemPromptAddendum: canvasAddendumMock,
}));
vi.mock("../mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../mcp")>();
  return { ...actual, loadManagedMcpServers: managedMock };
});
vi.mock("../sessions", () => ({
  saveToolCall: vi.fn(),
  updateToolCallStatus: vi.fn(),
  getDisabledMcpServers: vi.fn(() => []),
}));
vi.mock("./skills", () => ({ buildSkillsContext: vi.fn(() => "") }));
vi.mock("./provider-session-store", () => ({
  providerSessionStore: { get: vi.fn(() => ({})), set: vi.fn(), reset: vi.fn() },
}));

import { buildFileChange, reportedClaudeTurnCost, runClaudeAgentTurn } from "./claude";
import { providerSessionStore } from "./provider-session-store";
import { clearLastUsage, getLastReportedUsage } from "./turn-emitter";

// ─── buildFileChange ────────────────────────────────────────────────────────
//
// Pure function extracted from the SDK message loop so the before/after →
// FileChange logic (diff / binary / too-large classification) can be tested
// without spinning up a query stream. See issue #206: the surrounding I/O
// (readFileForDiff) was switched from readFileSync to async fs.promises so a
// large file being diffed can't block the main process event loop.

describe("buildFileChange", () => {
  it("computes a unified diff for text content", () => {
    const change = buildFileChange({
      filePath: "/project/src/foo.ts",
      relPath: "src/foo.ts",
      before: Buffer.from("old line\n"),
      beforeTooLarge: false,
      after: Buffer.from("new line\n"),
      afterTooLarge: false,
    });

    expect(change.isBinary).toBeUndefined();
    expect(change.tooLarge).toBeUndefined();
    expect(change.operation).toBe("write");
    expect(change.diff).toContain("-old line");
    expect(change.diff).toContain("+new line");
  });

  it("treats a null before-buffer as an empty file (new file)", () => {
    const change = buildFileChange({
      filePath: "/project/src/new.ts",
      relPath: "src/new.ts",
      before: null,
      beforeTooLarge: false,
      after: Buffer.from("created content\n"),
      afterTooLarge: false,
    });

    expect(change.diff).toContain("+created content");
  });

  it("marks the change binary when either buffer contains a NUL byte", () => {
    const change = buildFileChange({
      filePath: "/project/assets/img.png",
      relPath: "assets/img.png",
      before: Buffer.from([0x89, 0x50, 0x00, 0x47]),
      beforeTooLarge: false,
      after: Buffer.from([0x89, 0x50, 0x00, 0x47]),
      afterTooLarge: false,
    });

    expect(change.isBinary).toBe(true);
    expect(change.diff).toBe("");
    expect(change.tooLarge).toBeUndefined();
  });

  it("marks the change too-large when the before content exceeded the size threshold", () => {
    const change = buildFileChange({
      filePath: "/project/data/huge.json",
      relPath: "data/huge.json",
      before: null,
      beforeTooLarge: true,
      after: Buffer.from("small after\n"),
      afterTooLarge: false,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.diff).toBe("");
    expect(change.isBinary).toBeUndefined();
  });

  it("marks the change too-large when the after content exceeded the size threshold", () => {
    const change = buildFileChange({
      filePath: "/project/data/huge.json",
      relPath: "data/huge.json",
      before: Buffer.from("small before\n"),
      beforeTooLarge: false,
      after: null,
      afterTooLarge: true,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.diff).toBe("");
  });

  it("prioritizes too-large over binary detection", () => {
    const change = buildFileChange({
      filePath: "/project/assets/huge.bin",
      relPath: "assets/huge.bin",
      before: Buffer.from([0x00, 0x01]),
      beforeTooLarge: true,
      after: Buffer.from([0x00, 0x01]),
      afterTooLarge: false,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.isBinary).toBeUndefined();
  });
});

// ─── canvas injection (#223 / #242) ─────────────────────────────────────────

describe("runClaudeAgentTurn canvas injection", () => {
  const CANVAS_ENTRY = { type: "http", url: "http://127.0.0.1:1/canvas/c1/session/s1/mcp", headers: {} };
  const CANVAS_BLOCK = "\n\nAttached canvases — Release board (kanban)";

  beforeEach(() => {
    vi.clearAllMocks();
    managedMock.mockReturnValue({ "user-server": { type: "http", url: "http://example.test/mcp" } } as never);
    canvasServersMock.mockReturnValue({ "canvas-board-1234abcd": CANVAS_ENTRY } as never);
    canvasAddendumMock.mockReturnValue(CANVAS_BLOCK as never);
    queryMock.mockImplementation(() => (async function* () {})());
  });

  function run(noTools = false) {
    return runClaudeAgentTurn({
      db: {} as never,
      sessionId: "s1",
      messageId: "m1",
      sdkSessionId: null,
      prompt: "hi",
      projectPath: "/project",
      projectConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } as never,
      webContents: { send: vi.fn() } as never,
      noTools,
    });
  }

  it("passes the attached canvas entry in mcpServers alongside managed servers and aichemist-tools", async () => {
    await run();
    const options = queryMock.mock.calls[0][0].options;
    expect(canvasServersMock).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(Object.keys(options.mcpServers)).toEqual(
      expect.arrayContaining(["user-server", "canvas-board-1234abcd", "aichemist-tools"]),
    );
    expect(options.mcpServers["canvas-board-1234abcd"]).toMatchObject({ url: CANVAS_ENTRY.url });
  });

  it("appends the canvas addendum to the system prompt", async () => {
    await run();
    expect(canvasAddendumMock).toHaveBeenCalledWith(expect.anything(), "s1");
    expect(queryMock.mock.calls[0][0].options.systemPrompt).toContain(CANVAS_BLOCK);
  });

  it("injects no mcpServers for noTools turns", async () => {
    await run(true);
    expect(queryMock.mock.calls[0][0].options.mcpServers).toEqual({});
  });
});

// ─── provider-reported cost ─────────────────────────────────────────────────

describe("reportedClaudeTurnCost", () => {
  it("uses the whole total for a fresh SDK session", () => {
    expect(reportedClaudeTurnCost({ resumedFrom: null, resultSessionId: "a", totalUSD: 0.4, priorTotalUSD: null })).toBe(0.4);
  });

  it("uses the whole total when the resume produced a different SDK session", () => {
    expect(reportedClaudeTurnCost({ resumedFrom: "old", resultSessionId: "new", totalUSD: 0.4, priorTotalUSD: 3 })).toBe(0.4);
  });

  it("differences a resumed session's cumulative total against the stored baseline", () => {
    expect(reportedClaudeTurnCost({ resumedFrom: "a", resultSessionId: "a", totalUSD: 1.5, priorTotalUSD: 1.25 })).toBeCloseTo(0.25);
  });

  it("treats a total below the baseline as a reset running total", () => {
    expect(reportedClaudeTurnCost({ resumedFrom: "a", resultSessionId: "a", totalUSD: 0.1, priorTotalUSD: 2 })).toBe(0.1);
  });

  it("returns null for a resumed session with no baseline — the total would include earlier turns", () => {
    expect(reportedClaudeTurnCost({ resumedFrom: "a", resultSessionId: "a", totalUSD: 5, priorTotalUSD: null })).toBeNull();
  });
});

describe("runClaudeAgentTurn reported cost", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    managedMock.mockReturnValue({} as never);
    canvasServersMock.mockReturnValue({} as never);
    canvasAddendumMock.mockReturnValue("" as never);
    clearLastUsage("s1");
  });

  function stream(result: Record<string, unknown>) {
    queryMock.mockImplementation(() =>
      (async function* () {
        yield { type: "result", session_id: "sdk-1", ...result };
      })()
    );
  }

  function run(sdkSessionId: string | null) {
    return runClaudeAgentTurn({
      db: {} as never,
      sessionId: "s1",
      messageId: "m1",
      sdkSessionId,
      prompt: "hi",
      projectPath: "/project",
      projectConfig: { provider: "anthropic", model: "claude-sonnet-4-6" } as never,
      webContents: { send: vi.fn() } as never,
    });
  }

  it("reports the turn's cost and stores the new cumulative baseline", async () => {
    vi.mocked(providerSessionStore.get).mockReturnValue({ sdkSessionId: "sdk-1", costTotalUSD: 1 });
    stream({ total_cost_usd: 1.3, modelUsage: { "claude-sonnet-4-6": { costBasis: "list" } } });

    await run("sdk-1");

    expect(getLastReportedUsage("s1").cost_usd).toBeCloseTo(0.3);
    expect(providerSessionStore.set).toHaveBeenCalledWith({}, "s1", "claude", { sdkSessionId: "sdk-1", costTotalUSD: 1.3 });
  });

  it("doesn't report a cost the SDK priced on an unknown basis, but still records the baseline", async () => {
    vi.mocked(providerSessionStore.get).mockReturnValue({});
    stream({ total_cost_usd: 0.7, modelUsage: { "mystery-model": { costBasis: "unknown" } } });

    await run(null);

    expect(getLastReportedUsage("s1").cost_usd).toBeUndefined();
    expect(providerSessionStore.set).toHaveBeenCalledWith({}, "s1", "claude", { sdkSessionId: "sdk-1", costTotalUSD: 0.7 });
  });
});
