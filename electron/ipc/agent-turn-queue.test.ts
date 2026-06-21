// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const { getSessionMock, listProjectsMock, runAgentTurnMock, getIssueMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  listProjectsMock: vi.fn(),
  runAgentTurnMock: vi.fn(),
  getIssueMock: vi.fn(),
}));

vi.mock("../sessions", () => ({ getSession: getSessionMock }));
vi.mock("../projects", () => ({ listProjects: listProjectsMock }));
vi.mock("../agent/runner", () => ({ runAgentTurn: runAgentTurnMock }));
vi.mock("../github", () => ({ getIssue: getIssueMock }));

import {
  type TurnQueueContext,
  enqueueTurn,
  submitTurn,
  cleanupSessionQueueState,
} from "./agent-turn-queue";

const db = {} as unknown as Database;

function seedSession(sessionId: string) {
  getSessionMock.mockImplementation((_db, id: string) => ({
    id,
    project_id: "proj-1",
    provider: "ollama",
    model: "llama",
    skills: [],
    agent: null,
    github_issue_number: null,
    workspace_path: null,
    messages: [],
  }));
  listProjectsMock.mockReturnValue([
    { id: "proj-1", path: "/project", config: { provider: "ollama", model: "llama" } },
  ]);
  return sessionId;
}

/** A BrowserWindow stub that records every webContents.send call. */
function fakeWindow() {
  const send = vi.fn();
  const win = { webContents: { send } } as unknown as BrowserWindow;
  return { win, send };
}

describe("enqueueTurn (headless / programmatic)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentTurnMock.mockResolvedValue("done");
  });

  it("runs the turn, persists, and emits nothing when getMainWindow() is null", async () => {
    const sessionId = seedSession("sess-headless");
    const activeTurns = new Set<string>();
    const ctx: TurnQueueContext = { db, activeTurns, getMainWindow: () => null };

    const result = enqueueTurn(ctx, sessionId, { prompt: "scheduled work" });
    expect(result).toEqual({ queued: false });

    // The drain runs asynchronously — wait for the turn to complete.
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(1));

    const params = runAgentTurnMock.mock.calls[0][0];
    expect(params.sessionId).toBe(sessionId);
    expect(params.prompt).toBe("scheduled work");
    // Headless: a no-op webContents that emits nothing, never throws.
    expect(() => params.webContents.send("anything", {})).not.toThrow();
    // No renderer can answer a prompt, so the turn is forced non-interactive
    // even though the caller didn't set the flag — otherwise a gated tool /
    // ask_user would hang out the full 5-min approval timeout.
    expect(params.nonInteractive).toBe(true);

    // Queue is not wedged: activeTurns is released after the turn settles.
    await vi.waitFor(() => expect(activeTurns.has(sessionId)).toBe(false));

    // A follow-up enqueue runs again rather than being blocked.
    const second = enqueueTurn(ctx, sessionId, { prompt: "again" });
    expect(second).toEqual({ queued: false });
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(2));

    cleanupSessionQueueState(sessionId);
  });

  it("queues behind an in-flight turn instead of colliding", () => {
    const sessionId = seedSession("sess-busy");
    const activeTurns = new Set<string>([sessionId]); // a turn is already running
    const ctx: TurnQueueContext = { db, activeTurns, getMainWindow: () => null };

    const result = enqueueTurn(ctx, sessionId, { prompt: "queued", messageId: "m1" });
    expect(result).toEqual({ queued: true });
    expect(runAgentTurnMock).not.toHaveBeenCalled();

    cleanupSessionQueueState(sessionId);
  });

  it("forwards a window's webContents when one is attached", async () => {
    const sessionId = seedSession("sess-windowed");
    const { win, send } = fakeWindow();
    const activeTurns = new Set<string>();
    const ctx: TurnQueueContext = { db, activeTurns, getMainWindow: () => win };

    enqueueTurn(ctx, sessionId, { prompt: "with window" });
    await vi.waitFor(() => expect(runAgentTurnMock).toHaveBeenCalledTimes(1));

    expect(runAgentTurnMock.mock.calls[0][0].webContents).toBe(win.webContents);
    // A window is attached, so the turn stays interactive (the caller didn't
    // opt into non-interactive): an attached renderer can answer prompts.
    expect(runAgentTurnMock.mock.calls[0][0].nonInteractive).toBe(false);
    // The drain emits the queue-turn-start signal to the renderer.
    expect(send).toHaveBeenCalled();

    cleanupSessionQueueState(sessionId);
  });
});

describe("submitTurn (user-driven) preserves existing behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runAgentTurnMock.mockResolvedValue("done");
  });

  it("throws when no window is available", async () => {
    const ctx: TurnQueueContext = {
      db,
      activeTurns: new Set<string>(),
      getMainWindow: () => null,
    };
    await expect(submitTurn(ctx, "sess-x", { prompt: "hi" })).rejects.toThrow(/No window available/);
  });

  it("runs a turn directly and returns { queued: false } when idle", async () => {
    const sessionId = seedSession("sess-direct");
    const { win } = fakeWindow();
    const activeTurns = new Set<string>();
    const ctx: TurnQueueContext = { db, activeTurns, getMainWindow: () => win };

    const result = await submitTurn(ctx, sessionId, { prompt: "hello" });
    expect(result).toEqual({ queued: false });
    expect(runAgentTurnMock).toHaveBeenCalledTimes(1);
    expect(activeTurns.has(sessionId)).toBe(false);

    cleanupSessionQueueState(sessionId);
  });

  it("rejects queueing a non-chat turn when the session is busy", async () => {
    const sessionId = seedSession("sess-nonchat");
    const { win } = fakeWindow();
    const ctx: TurnQueueContext = {
      db,
      activeTurns: new Set<string>([sessionId]),
      getMainWindow: () => win,
    };

    await expect(
      submitTurn(ctx, sessionId, { prompt: "draft", skipPersistence: true })
    ).rejects.toThrow(/busy/);

    cleanupSessionQueueState(sessionId);
  });

  it("queues a chat turn (with messageId) when the session is busy", async () => {
    const sessionId = seedSession("sess-chatqueue");
    const { win } = fakeWindow();
    const ctx: TurnQueueContext = {
      db,
      activeTurns: new Set<string>([sessionId]),
      getMainWindow: () => win,
    };

    const result = await submitTurn(ctx, sessionId, { prompt: "next", messageId: "m2" });
    expect(result).toEqual({ queued: true });
    expect(runAgentTurnMock).not.toHaveBeenCalled();

    cleanupSessionQueueState(sessionId);
  });
});
