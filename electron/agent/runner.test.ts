// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { copilotRunMock, createPlaceholderMessageMock, loadToolCallsForMessageMock, updateSessionStatusMock, recordUsageMock } =
  vi.hoisted(() => ({
    copilotRunMock: vi.fn(),
    createPlaceholderMessageMock: vi.fn(() => ({
      id: "msg-1",
      session_id: "sess-1",
      role: "assistant" as const,
      content: "",
      tool_calls: [],
      created_at: "2024-01-01T00:00:00Z",
      agent: null,
    })),
    loadToolCallsForMessageMock: vi.fn(() => [{
      id: "tool-1",
      name: "bash",
      args: {},
      result: null,
      status: "complete",
      category: "shell",
    }]),
    updateSessionStatusMock: vi.fn(),
    recordUsageMock: vi.fn(),
  }));

vi.mock("./copilot", () => ({
  copilotProvider: { run: copilotRunMock },
}));
vi.mock("./claude", () => ({
  claudeProvider: { run: vi.fn() },
}));
vi.mock("./ollama", () => ({
  ollamaProvider: { run: vi.fn() },
}));

vi.mock("../sessions", () => ({
  createPlaceholderMessage: createPlaceholderMessageMock,
  updateMessageContent: vi.fn(),
  loadToolCallsForMessage: loadToolCallsForMessageMock,
  updateSessionStatus: updateSessionStatusMock,
}));

vi.mock("../usage-ledger", () => ({
  recordUsage: recordUsageMock,
}));

import { runAgentTurn } from "./runner";
import { TurnEmitter } from "./turn-emitter";

describe("runAgentTurn skipPersistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes placeholder message on provider errors when skipPersistence is enabled", async () => {
    copilotRunMock.mockRejectedValueOnce(new Error("provider failed"));

    const deleteRun = vi.fn();
    const db = {
      prepare: vi.fn().mockReturnValue({ run: deleteRun }),
    };
    const webContents = { send: vi.fn() };

    await expect(runAgentTurn({
      db: db as any,
      sessionId: "sess-1",
      projectId: "proj-1",
      prompt: "draft a PR",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
      skipPersistence: true,
    })).rejects.toThrow("provider failed");

    expect(db.prepare).toHaveBeenCalledWith("DELETE FROM messages WHERE id = ?");
    expect(deleteRun).toHaveBeenCalledWith("msg-1");
    expect(loadToolCallsForMessageMock).not.toHaveBeenCalled();
  });

  it("passes noTools: true to the provider when skipPersistence is enabled", async () => {
    copilotRunMock.mockResolvedValueOnce("draft text");

    const deleteRun = vi.fn();
    const db = {
      prepare: vi.fn().mockReturnValue({ run: deleteRun }),
    };
    const webContents = { send: vi.fn() };

    await runAgentTurn({
      db: db as any,
      sessionId: "sess-1",
      projectId: "proj-1",
      prompt: "draft a PR",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
      skipPersistence: true,
    });

    expect(copilotRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ noTools: true })
    );
  });

  it("passes noTools: false to the provider for normal (non-skipPersistence) turns", async () => {
    copilotRunMock.mockResolvedValueOnce("response");
    loadToolCallsForMessageMock.mockReturnValueOnce([]);

    const db = {
      prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn() }),
    };
    const webContents = { send: vi.fn() };

    await runAgentTurn({
      db: db as any,
      sessionId: "sess-1",
      projectId: "proj-1",
      prompt: "help me",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
    });

    expect(copilotRunMock).toHaveBeenCalledWith(
      expect.objectContaining({ noTools: false })
    );
  });
});

describe("runAgentTurn usage ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeDb() {
    return { prepare: vi.fn().mockReturnValue({ run: vi.fn(), get: vi.fn() }) };
  }

  it("records usage after a successful turn, keyed by session/project/provider/model", async () => {
    loadToolCallsForMessageMock.mockReturnValueOnce([]);

    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 };
    copilotRunMock.mockImplementationOnce(async (params: { webContents: Electron.WebContents; sessionId: string }) => {
      new TurnEmitter(params.webContents, params.sessionId).usage(usage);
      return "response";
    });

    const db = makeDb();
    const webContents = { send: vi.fn() };

    await runAgentTurn({
      db: db as any,
      sessionId: "sess-1",
      projectId: "proj-1",
      prompt: "help me",
      projectPath: "/project",
      projectConfig: { provider: "copilot", model: "gpt-x" } as any,
      webContents: webContents as any,
    });

    expect(recordUsageMock).toHaveBeenCalledWith(db, {
      sessionId: "sess-1",
      projectId: "proj-1",
      provider: "copilot",
      model: "gpt-x",
      usage,
    });
  });

  it("records an all-zero usage row when the provider never calls usage()", async () => {
    copilotRunMock.mockResolvedValueOnce("response");
    loadToolCallsForMessageMock.mockReturnValueOnce([]);

    const db = makeDb();
    const webContents = { send: vi.fn() };

    await runAgentTurn({
      db: db as any,
      sessionId: "sess-2",
      projectId: "proj-1",
      prompt: "help me",
      projectPath: "/project",
      projectConfig: { provider: "copilot", model: "" } as any,
      webContents: webContents as any,
    });

    expect(recordUsageMock).toHaveBeenCalledWith(db, {
      sessionId: "sess-2",
      projectId: "proj-1",
      provider: "copilot",
      model: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  });

  it("does not leak a prior turn's usage into a later turn with no usage of its own", async () => {
    const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 1 };
    copilotRunMock.mockImplementationOnce(async (params: { webContents: Electron.WebContents; sessionId: string }) => {
      new TurnEmitter(params.webContents, params.sessionId).usage(usage);
      return "first";
    });
    loadToolCallsForMessageMock.mockReturnValue([]);

    const db = makeDb();
    const webContents = { send: vi.fn() };

    await runAgentTurn({
      db: db as any,
      sessionId: "sess-3",
      projectId: "proj-1",
      prompt: "first",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
    });

    copilotRunMock.mockResolvedValueOnce("second");
    await runAgentTurn({
      db: db as any,
      sessionId: "sess-3",
      projectId: "proj-1",
      prompt: "second",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
    });

    expect(recordUsageMock).toHaveBeenLastCalledWith(db, expect.objectContaining({
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }));
  });

  it("does not record usage when the provider throws", async () => {
    copilotRunMock.mockRejectedValueOnce(new Error("boom"));
    const db = makeDb();
    const webContents = { send: vi.fn() };

    await expect(runAgentTurn({
      db: db as any,
      sessionId: "sess-4",
      projectId: "proj-1",
      prompt: "help me",
      projectPath: "/project",
      projectConfig: { provider: "copilot" } as any,
      webContents: webContents as any,
    })).rejects.toThrow("boom");

    expect(recordUsageMock).not.toHaveBeenCalled();
  });
});
