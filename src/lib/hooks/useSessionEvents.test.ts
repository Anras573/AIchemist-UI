import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSessionEvents } from "@/lib/hooks/useSessionEvents";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { IPC_CHANNELS } from "@/lib/ipc";
import type { Session } from "@/types";

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
    skills: null,
    ...overrides,
  };
}

/**
 * Returns the callback registered for a given IPC channel.
 * useSessionEvents calls window.electronAPI.on(channel, cb) for each channel
 * it subscribes to. We capture it here so tests can fire events directly.
 */
function getCb(channel: string): (payload: unknown) => void {
  const calls = vi.mocked(window.electronAPI.on).mock.calls;
  const found = calls.find(([ch]) => ch === channel);
  if (!found) throw new Error(`No listener registered for channel "${channel}"`);
  return found[1] as (payload: unknown) => void;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("useSessionEvents", () => {
  it("registers listeners for all session channels on mount", () => {
    renderHook(() => useSessionEvents());

    const registeredChannels = vi
      .mocked(window.electronAPI.on)
      .mock.calls.map(([ch]) => ch);

    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_STATUS);
    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_DELTA);
    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_MESSAGE);
    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_TOOL_CALL);
    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_TOOL_RESULT);
    expect(registeredChannels).toContain(IPC_CHANNELS.SESSION_APPROVAL_REQUIRED);
  });

  it("unregisters all listeners on unmount", () => {
    const { unmount } = renderHook(() => useSessionEvents());
    unmount();
    expect(window.electronAPI.off).toHaveBeenCalled();
  });

  // ── session:status ──────────────────────────────────────────────────────────

  describe("session:status event", () => {
    it("updates session status in the store", () => {
      useSessionStore.getState().addSession(makeSession({ status: "idle" }));
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_STATUS)({ session_id: "sess-1", status: "running" });

      expect(useSessionStore.getState().sessions["sess-1"].status).toBe("running");
    });

    it("clears streaming text when status becomes idle", () => {
      useSessionStore.getState().addSession(makeSession());
      useSessionStore.getState().appendStreamingDelta("sess-1", "partial...");
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_STATUS)({ session_id: "sess-1", status: "idle" });

      expect(useSessionStore.getState().streamingText["sess-1"]).toBeUndefined();
    });

    it("clears streaming text when status becomes error", () => {
      useSessionStore.getState().addSession(makeSession());
      useSessionStore.getState().appendStreamingDelta("sess-1", "partial...");
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_STATUS)({ session_id: "sess-1", status: "error" });

      expect(useSessionStore.getState().streamingText["sess-1"]).toBeUndefined();
    });

    it("does not clear streaming text for non-terminal statuses", () => {
      useSessionStore.getState().addSession(makeSession());
      useSessionStore.getState().appendStreamingDelta("sess-1", "streaming...");
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_STATUS)({ session_id: "sess-1", status: "running" });

      expect(useSessionStore.getState().streamingText["sess-1"]).toBe("streaming...");
    });
  });

  // ── session:delta ───────────────────────────────────────────────────────────

  describe("session:delta event", () => {
    it("appends text delta to the streaming buffer", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_DELTA)({ session_id: "sess-1", text_delta: "Hello" });
      getCb(IPC_CHANNELS.SESSION_DELTA)({ session_id: "sess-1", text_delta: " world" });

      expect(useSessionStore.getState().streamingText["sess-1"]).toBe("Hello world");
    });
  });

  // ── session:message ─────────────────────────────────────────────────────────

  describe("session:message event", () => {
    it("commits the message to the session and clears streaming text", () => {
      const session = makeSession();
      useSessionStore.getState().addSession(session);
      useSessionStore.getState().appendStreamingDelta("sess-1", "streaming...");
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_MESSAGE)({
        session_id: "sess-1",
        message: {
          id: "msg-1",
          session_id: "sess-1",
          role: "assistant",
          content: "Hello",
          tool_calls: [],
          created_at: "2024-01-01T00:00:01Z",
        },
      });

      expect(useSessionStore.getState().sessions["sess-1"].messages).toHaveLength(1);
      expect(useSessionStore.getState().streamingText["sess-1"]).toBeUndefined();
    });
  });

  // ── session:tool_call ───────────────────────────────────────────────────────

  describe("session:tool_call event", () => {
    it("adds a live tool call to the store", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_CALL)({
        session_id: "sess-1",
        tool_name: "read_file",
        input: { path: "/src/main.ts" },
      });

      const calls = useSessionStore.getState().liveToolCalls["sess-1"];
      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe("read_file");
    });

    it("appends a shell prompt line to terminal output for execute_bash", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_CALL)({
        session_id: "sess-1",
        tool_name: "execute_bash",
        input: { command: "ls -la" },
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toBe("$ ls -la\n");
    });

    it("appends a shell prompt for the 'Bash' Claude Code built-in tool", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_CALL)({
        session_id: "sess-1",
        tool_name: "Bash",
        input: { command: "echo hello" },
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toBe("$ echo hello\n");
    });

    it("does not append terminal output for non-shell tools", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_CALL)({
        session_id: "sess-1",
        tool_name: "read_file",
        input: { path: "/foo" },
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toBeUndefined();
    });
  });

  // ── session:tool_result ─────────────────────────────────────────────────────

  describe("session:tool_result event", () => {
    it("formats plain-string bash output and appends to terminal", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_RESULT)({
        session_id: "sess-1",
        tool_name: "execute_bash",
        output: JSON.stringify({ stdout: "file1\nfile2", stderr: "", exit_code: 0 }),
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toContain("file1\nfile2");
    });

    it("includes stderr and non-zero exit code in terminal output", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_RESULT)({
        session_id: "sess-1",
        tool_name: "execute_bash",
        output: JSON.stringify({ stdout: "", stderr: "permission denied", exit_code: 1 }),
      });

      const out = useSessionStore.getState().terminalOutput["sess-1"]!;
      expect(out).toContain("permission denied");
      expect(out).toContain("[exit code: 1]");
    });

    it("handles MCP nested output format { content: [{type, text}] }", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_RESULT)({
        session_id: "sess-1",
        tool_name: "execute_bash",
        output: {
          content: [
            { type: "text", text: JSON.stringify({ stdout: "hello", stderr: "", exit_code: 0 }) },
          ],
        },
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toContain("hello");
    });

    it("falls back gracefully when output is not valid JSON", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_RESULT)({
        session_id: "sess-1",
        tool_name: "Bash",
        output: "plain text output",
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toContain(
        "plain text output"
      );
    });

    it("does not append terminal output for non-shell tool results", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_TOOL_RESULT)({
        session_id: "sess-1",
        tool_name: "read_file",
        output: "file contents",
      });

      expect(useSessionStore.getState().terminalOutput["sess-1"]).toBeUndefined();
    });
  });

  // ── session:approval_required ───────────────────────────────────────────────

  describe("session:approval_required event", () => {
    it("adds a pending approval to the store", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_APPROVAL_REQUIRED)({
        session_id: "sess-1",
        approval_id: "appr-1",
        tool_name: "execute_bash",
        input: { command: "rm -rf /" },
      });

      const approvals = useSessionStore.getState().pendingApprovals["sess-1"];
      expect(approvals).toHaveLength(1);
      expect(approvals[0].toolName).toBe("execute_bash");
      expect(approvals[0].approvalId).toBe("appr-1");
    });

    it("approval resolve() calls ipc.approveToolCall with the correct args", () => {
      renderHook(() => useSessionEvents());

      getCb(IPC_CHANNELS.SESSION_APPROVAL_REQUIRED)({
        session_id: "sess-1",
        approval_id: "appr-1",
        tool_name: "execute_bash",
        input: {},
      });

      const approval = useSessionStore.getState().pendingApprovals["sess-1"][0];
      approval.resolve(true);

      expect(window.electronAPI.approveToolCall).toHaveBeenCalledWith(
        "sess-1",
        "appr-1",
        true,
        undefined
      );
    });
  });
});

// ─── SESSION_FILE_CHANGE ──────────────────────────────────────────────────────

describe("SESSION_FILE_CHANGE", () => {
  beforeEach(() => {
    useSessionStore.setState({ sessionFileChanges: {}, tabSwitchRequest: null });
  });
  it("registers a listener for SESSION_FILE_CHANGE", () => {
    renderHook(() => useSessionEvents());
    const channels = vi.mocked(window.electronAPI.on).mock.calls.map(([ch]) => ch);
    expect(channels).toContain(IPC_CHANNELS.SESSION_FILE_CHANGE);
  });

  it("calls addFileChange with the correct sessionId and change", () => {
    renderHook(() => useSessionEvents());

    const change = {
      path: "/proj/src/app.ts",
      relativePath: "src/app.ts",
      diff: "--- src/app.ts\n+++ src/app.ts\n@@ -1 +1 @@\n-old\n+new",
      operation: "write" as const,
    };

    getCb(IPC_CHANNELS.SESSION_FILE_CHANGE)({
      session_id: "sess-1",
      file_change: change,
    });

    const changes = useSessionStore.getState().sessionFileChanges["sess-1"];
    expect(changes).toHaveLength(1);
    expect(changes[0].relativePath).toBe("src/app.ts");
    expect(changes[0].operation).toBe("write");
  });

  it("sets tabSwitchRequest to 'changes' when a file change arrives", () => {
    renderHook(() => useSessionEvents());

    getCb(IPC_CHANNELS.SESSION_FILE_CHANGE)({
      session_id: "sess-1",
      file_change: { path: "/x", relativePath: "x", diff: "", operation: "write" as const },
    });

    expect(useSessionStore.getState().tabSwitchRequest).toBe("changes");
  });

  it("accumulates multiple file changes for the same session", () => {
    renderHook(() => useSessionEvents());

    const fire = (rel: string) =>
      getCb(IPC_CHANNELS.SESSION_FILE_CHANGE)({
        session_id: "sess-1",
        file_change: { path: `/${rel}`, relativePath: rel, diff: "", operation: "write" as const },
      });

    fire("a.ts");
    fire("b.ts");
    fire("c.ts");

    expect(useSessionStore.getState().sessionFileChanges["sess-1"]).toHaveLength(3);
  });
});
