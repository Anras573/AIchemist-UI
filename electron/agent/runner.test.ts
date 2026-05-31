// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { copilotRunMock, createPlaceholderMessageMock, loadToolCallsForMessageMock, updateSessionStatusMock } =
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

import { runAgentTurn } from "./runner";

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
