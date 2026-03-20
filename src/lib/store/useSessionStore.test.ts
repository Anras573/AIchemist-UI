import { describe, it, expect, vi } from "vitest";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { Session, Message } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test session",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    session_id: "sess-1",
    role: "assistant",
    content: "Hello",
    tool_calls: [],
    created_at: "2024-01-01T00:00:01Z",
    ...overrides,
  };
}

const get = () => useSessionStore.getState();

// ─── mergeSessions ────────────────────────────────────────────────────────────

describe("mergeSessions", () => {
  it("adds new sessions to the store", () => {
    const session = makeSession();
    get().mergeSessions([session]);
    expect(get().sessions["sess-1"]).toBeDefined();
  });

  it("does not remove sessions from other projects", () => {
    const a = makeSession({ id: "a" });
    const b = makeSession({ id: "b" });
    get().mergeSessions([a]);
    get().mergeSessions([b]);
    expect(get().sessions["a"]).toBeDefined();
    expect(get().sessions["b"]).toBeDefined();
  });

  it("preserves existing messages when incoming session has empty messages", () => {
    const msg = makeMessage();
    const withMessages = makeSession({ messages: [msg] });
    get().addSession(withMessages);

    // Simulate listSessions returning the session with messages: []
    get().mergeSessions([makeSession({ messages: [] })]);

    expect(get().sessions["sess-1"].messages).toHaveLength(1);
    expect(get().sessions["sess-1"].messages[0].id).toBe("msg-1");
  });

  it("updates metadata (title) from the incoming session", () => {
    get().addSession(makeSession({ title: "Old title" }));
    get().mergeSessions([makeSession({ title: "New title", messages: [] })]);
    expect(get().sessions["sess-1"].title).toBe("New title");
  });
});

// ─── hydrateSession ───────────────────────────────────────────────────────────

describe("hydrateSession", () => {
  it("replaces messages with the hydrated set", () => {
    get().addSession(makeSession({ messages: [] }));
    const msg = makeMessage();
    get().hydrateSession(makeSession({ messages: [msg] }));
    expect(get().sessions["sess-1"].messages).toHaveLength(1);
  });

  it("updates the title from the hydrated session", () => {
    get().addSession(makeSession({ title: "Old" }));
    get().hydrateSession(makeSession({ title: "Hydrated title", messages: [] }));
    expect(get().sessions["sess-1"].title).toBe("Hydrated title");
  });

  it("creates the session entry if it did not exist yet", () => {
    get().hydrateSession(makeSession({ id: "new-sess" }));
    expect(get().sessions["new-sess"]).toBeDefined();
  });
});

// ─── commitMessage ────────────────────────────────────────────────────────────

describe("commitMessage", () => {
  it("appends a message and clears streaming text atomically", () => {
    get().addSession(makeSession());
    get().appendStreamingDelta("sess-1", "partial...");

    const msg = makeMessage();
    get().commitMessage("sess-1", msg);

    expect(get().sessions["sess-1"].messages).toHaveLength(1);
    expect(get().streamingText["sess-1"]).toBeUndefined();
  });

  it("deduplicates — calling with the same message ID twice is a no-op", () => {
    get().addSession(makeSession());
    const msg = makeMessage();
    get().commitMessage("sess-1", msg);
    get().commitMessage("sess-1", msg);
    expect(get().sessions["sess-1"].messages).toHaveLength(1);
  });

  it("is a no-op when the session does not exist", () => {
    expect(() => get().commitMessage("nonexistent", makeMessage())).not.toThrow();
  });
});

// ─── appendStreamingDelta ─────────────────────────────────────────────────────

describe("appendStreamingDelta", () => {
  it("concatenates deltas across multiple calls", () => {
    get().appendStreamingDelta("sess-1", "Hello");
    get().appendStreamingDelta("sess-1", ", ");
    get().appendStreamingDelta("sess-1", "world");
    expect(get().streamingText["sess-1"]).toBe("Hello, world");
  });

  it("does not affect other sessions", () => {
    get().appendStreamingDelta("sess-1", "A");
    get().appendStreamingDelta("sess-2", "B");
    expect(get().streamingText["sess-1"]).toBe("A");
    expect(get().streamingText["sess-2"]).toBe("B");
  });
});

// ─── removeSession ────────────────────────────────────────────────────────────

describe("removeSession", () => {
  it("removes the session from the store", () => {
    get().addSession(makeSession());
    get().removeSession("sess-1");
    expect(get().sessions["sess-1"]).toBeUndefined();
  });

  it("clears activeSessionId when the removed session was active", () => {
    get().addSession(makeSession());
    get().setActiveSession("sess-1");
    get().removeSession("sess-1");
    expect(get().activeSessionId).toBeNull();
  });

  it("leaves activeSessionId unchanged when removing a different session", () => {
    get().addSession(makeSession({ id: "sess-1" }));
    get().addSession(makeSession({ id: "sess-2" }));
    get().setActiveSession("sess-1");
    get().removeSession("sess-2");
    expect(get().activeSessionId).toBe("sess-1");
  });
});

// ─── updateSessionStatus ──────────────────────────────────────────────────────

describe("updateSessionStatus", () => {
  it("updates the status of the target session", () => {
    get().addSession(makeSession({ status: "idle" }));
    get().updateSessionStatus("sess-1", "running");
    expect(get().sessions["sess-1"].status).toBe("running");
  });

  it("is a no-op for unknown session IDs", () => {
    expect(() => get().updateSessionStatus("ghost", "running")).not.toThrow();
  });
});

// ─── clearPendingApprovals ────────────────────────────────────────────────────

describe("clearPendingApprovals", () => {
  it("calls resolve(false) on each pending approval before removing", () => {
    const resolve1 = vi.fn();
    const resolve2 = vi.fn();
    get().addPendingApproval("sess-1", {
      approvalId: "a1",
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
      resolve: resolve1,
    });
    get().addPendingApproval("sess-1", {
      approvalId: "a2",
      toolCallId: "tc2",
      toolName: "read_file",
      args: {},
      resolve: resolve2,
    });

    get().clearPendingApprovals("sess-1");

    expect(resolve1).toHaveBeenCalledWith(false);
    expect(resolve2).toHaveBeenCalledWith(false);
    expect(get().pendingApprovals["sess-1"]).toBeUndefined();
  });
});

// ─── resolveApproval ──────────────────────────────────────────────────────────

describe("resolveApproval", () => {
  it("calls resolve(true) and removes the approval from the list", () => {
    const resolve = vi.fn();
    get().addPendingApproval("sess-1", {
      approvalId: "a1",
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
      resolve,
    });

    get().resolveApproval("sess-1", "a1", true);

    expect(resolve).toHaveBeenCalledWith(true);
    expect(get().pendingApprovals["sess-1"]).toHaveLength(0);
  });

  it("calls resolve(false) when denied", () => {
    const resolve = vi.fn();
    get().addPendingApproval("sess-1", {
      approvalId: "a1",
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
      resolve,
    });

    get().resolveApproval("sess-1", "a1", false);

    expect(resolve).toHaveBeenCalledWith(false);
  });

  it("only removes the matched approval, leaving others intact", () => {
    const r1 = vi.fn();
    const r2 = vi.fn();
    get().addPendingApproval("sess-1", {
      approvalId: "a1",
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
      resolve: r1,
    });
    get().addPendingApproval("sess-1", {
      approvalId: "a2",
      toolCallId: "tc2",
      toolName: "read_file",
      args: {},
      resolve: r2,
    });

    get().resolveApproval("sess-1", "a1", true);

    expect(get().pendingApprovals["sess-1"]).toHaveLength(1);
    expect(get().pendingApprovals["sess-1"][0].approvalId).toBe("a2");
  });
});

// ─── live tool calls ──────────────────────────────────────────────────────────

describe("live tool calls", () => {
  it("adds and updates tool results", () => {
    get().addLiveToolCall("sess-1", {
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: { command: "ls" },
    });

    get().updateLiveToolResult("sess-1", "tc1", "file1\nfile2");

    const call = get().liveToolCalls["sess-1"][0];
    expect(call.result).toBe("file1\nfile2");
    expect(call.error).toBeUndefined();
  });

  it("sets an error on a tool call", () => {
    get().addLiveToolCall("sess-1", {
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
    });
    get().updateLiveToolError("sess-1", "tc1", "permission denied");
    expect(get().liveToolCalls["sess-1"][0].error).toBe("permission denied");
  });

  it("clearLiveToolCalls removes all calls for the session", () => {
    get().addLiveToolCall("sess-1", {
      toolCallId: "tc1",
      toolName: "execute_bash",
      args: {},
    });
    get().clearLiveToolCalls("sess-1");
    expect(get().liveToolCalls["sess-1"]).toBeUndefined();
  });
});

// ─── sessionAgents / setSessionAgent ─────────────────────────────────────────

describe("setSessionAgent", () => {
  it("initial sessionAgents is empty", () => {
    expect(get().sessionAgents).toEqual({});
  });

  it("sets the agent for a session", () => {
    get().setSessionAgent("sess-1", "research");
    expect(get().sessionAgents["sess-1"]).toBe("research");
  });

  it("overwrites the agent for the same session", () => {
    get().setSessionAgent("sess-1", "research");
    get().setSessionAgent("sess-1", "coder");
    expect(get().sessionAgents["sess-1"]).toBe("coder");
  });

  it("clears the agent when null is passed", () => {
    get().setSessionAgent("sess-1", "research");
    get().setSessionAgent("sess-1", null);
    expect(get().sessionAgents["sess-1"]).toBeUndefined();
  });

  it("does not affect agents for other sessions", () => {
    get().setSessionAgent("sess-1", "research");
    get().setSessionAgent("sess-2", "coder");
    get().setSessionAgent("sess-1", null);
    expect(get().sessionAgents["sess-2"]).toBe("coder");
  });
});
