import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAgentTurn } from "@/lib/hooks/useAgentTurn";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Message, Project, Session } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agent: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/proj",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
    },
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    session_id: "sess-1",
    role: "user",
    content: "Hello",
    tool_calls: [],
    created_at: "2024-01-01T00:00:01Z",
    ...overrides,
  };
}

/** Sets up the stores with an active session and project ready to receive messages. */
function setupActiveSession(sessionOverrides: Partial<Session> = {}) {
  const session = makeSession(sessionOverrides);
  const project = makeProject();
  useSessionStore.getState().addSession(session);
  useSessionStore.getState().setActiveSession(session.id);
  useProjectStore.getState().addProject(project);
  useProjectStore.getState().setActiveProject(project.id);
  return { session, project };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useAgentTurn", () => {
  it("returns early without calling ipc when there is no active session", async () => {
    // No active session set — stores are in reset state
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("hello");
    });

    expect(window.electronAPI.saveMessage).not.toHaveBeenCalled();
    expect(window.electronAPI.agentSend).not.toHaveBeenCalled();
  });

  it("calls ipc.saveMessage with the user text and role", async () => {
    setupActiveSession();
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("Hello agent");
    });

    expect(window.electronAPI.saveMessage).toHaveBeenCalledWith({
      sessionId: "sess-1",
      role: "user",
      content: "Hello agent",
    });
  });

  it("appends the saved message to the session store", async () => {
    setupActiveSession();
    const msg = makeMessage({ content: "Hello agent" });
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(msg);
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("Hello agent");
    });

    expect(useSessionStore.getState().sessions["sess-1"].messages).toContainEqual(msg);
  });

  it("sets session status to 'running' before calling agentSend", async () => {
    setupActiveSession();
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());

    let statusDuringAgentSend = "";
    vi.mocked(window.electronAPI.agentSend).mockImplementation(async () => {
      statusDuringAgentSend =
        useSessionStore.getState().sessions["sess-1"].status;
    });

    const { result } = renderHook(() => useAgentTurn());
    await act(async () => {
      await result.current.sendMessage("go");
    });

    expect(statusDuringAgentSend).toBe("running");
  });

  it("auto-titles the session from the first user message (≤60 chars)", async () => {
    setupActiveSession({ messages: [] });
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    vi.mocked(window.electronAPI.updateSessionTitle).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("Short message");
    });

    expect(window.electronAPI.updateSessionTitle).toHaveBeenCalledWith(
      "sess-1",
      "Short message"
    );
  });

  it("truncates the auto-title at 60 chars with an ellipsis", async () => {
    setupActiveSession({ messages: [] });
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    vi.mocked(window.electronAPI.updateSessionTitle).mockResolvedValue(undefined);
    const { result } = renderHook(() => useAgentTurn());

    const longText = "A".repeat(80);
    await act(async () => {
      await result.current.sendMessage(longText);
    });

    const [, title] = vi
      .mocked(window.electronAPI.updateSessionTitle)
      .mock.calls[0];
    expect(title).toHaveLength(58);
    expect((title as string).endsWith("…")).toBe(true);
  });

  it("does not auto-title on subsequent messages", async () => {
    const existingMsg = makeMessage({ id: "existing" });
    setupActiveSession({ messages: [existingMsg] });
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage({ id: "new" }));
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("Second message");
    });

    expect(window.electronAPI.updateSessionTitle).not.toHaveBeenCalled();
  });

  it("clears live tool calls after agentSend resolves", async () => {
    setupActiveSession();
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    useSessionStore.getState().addLiveToolCall("sess-1", {
      toolCallId: "tc-1",
      toolName: "execute_bash",
      args: {},
    });
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("go");
    });

    expect(useSessionStore.getState().liveToolCalls["sess-1"]).toBeUndefined();
  });

  it("sets status to 'error' and clears state when agentSend rejects", async () => {
    setupActiveSession();
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    vi.mocked(window.electronAPI.agentSend).mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("go");
    });

    expect(useSessionStore.getState().sessions["sess-1"].status).toBe("error");
    expect(useSessionStore.getState().streamingText["sess-1"]).toBeUndefined();
    expect(useSessionStore.getState().liveToolCalls["sess-1"]).toBeUndefined();
  });

  it("passes the active agent to agentSend when one is selected", async () => {
    setupActiveSession();
    useSessionStore.getState().setSessionAgent("sess-1", "research");
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("go");
    });

    expect(window.electronAPI.agentSend).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "research" })
    );
  });

  it("passes agent as undefined when no agent is selected", async () => {
    setupActiveSession();
    vi.mocked(window.electronAPI.saveMessage).mockResolvedValue(makeMessage());
    const { result } = renderHook(() => useAgentTurn());

    await act(async () => {
      await result.current.sendMessage("go");
    });

    expect(window.electronAPI.agentSend).toHaveBeenCalledWith(
      expect.objectContaining({ agent: undefined })
    );
  });
});
