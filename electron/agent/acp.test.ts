// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleSessionUpdate,
  mapAcpStatus,
  mapAcpKindToCategory,
  _resetAcpStateForTests,
} from "./acp";
import * as CH from "../ipc-channels";

// Mock the SQLite session helpers — we capture calls instead of opening a real DB.
vi.mock("../sessions", () => ({
  saveToolCall: vi.fn(),
  updateToolCallStatus: vi.fn(),
  setAcpSessionId: vi.fn(),
}));

import { saveToolCall, updateToolCallStatus } from "../sessions";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx() {
  const sent: Array<{ channel: string; payload: any }> = [];
  return {
    ctx: {
      db: {} as any,
      webContents: {
        send: (channel: string, payload: any) => {
          sent.push({ channel, payload });
        },
      } as any,
      aiSessionId: "ai-1",
      messageId: "msg-1",
      acpSessionId: "acp-1",
      projectConfig: { provider: "acp", model: "x" } as any,
      projectPath: "/tmp/proj",
      buffer: [] as string[],
      toolCallIds: new Set<string>(),
    },
    sent,
  };
}

beforeEach(() => {
  _resetAcpStateForTests();
  vi.clearAllMocks();
});

// ── mapAcpStatus ─────────────────────────────────────────────────────────────

describe("mapAcpStatus", () => {
  const cases: Array<[string, string]> = [
    ["pending", "pending_approval"],
    ["in_progress", "approved"],
    ["completed", "complete"],
    ["failed", "error"],
    ["unknown_future_value", "approved"],
  ];
  it.each(cases)("maps %s → %s", (input, expected) => {
    expect(mapAcpStatus(input)).toBe(expected);
  });
});

// ── mapAcpKindToCategory ─────────────────────────────────────────────────────

describe("mapAcpKindToCategory", () => {
  it("maps file-touching kinds to filesystem", () => {
    for (const k of ["edit", "read", "delete", "move", "search", "fetch"]) {
      expect(mapAcpKindToCategory(k)).toBe("filesystem");
    }
  });
  it("maps execute → shell", () => {
    expect(mapAcpKindToCategory("execute")).toBe("shell");
  });
  it("falls back to other for unknown kinds", () => {
    expect(mapAcpKindToCategory(undefined)).toBe("other");
    expect(mapAcpKindToCategory("think")).toBe("other");
    expect(mapAcpKindToCategory("future_kind")).toBe("other");
  });
});

// ── handleSessionUpdate ──────────────────────────────────────────────────────

describe("handleSessionUpdate", () => {
  it("emits SESSION_DELTA for agent_message_chunk text", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "Hello" },
    });
    expect(ctx.buffer).toEqual(["Hello"]);
    expect(sent).toEqual([
      {
        channel: CH.SESSION_DELTA,
        payload: { session_id: "ai-1", text_delta: "Hello" },
      },
    ]);
  });

  it("ignores agent_message_chunk with non-text content", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "image", data: "..." },
    });
    expect(ctx.buffer).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("inserts a tool_call row and emits SESSION_TOOL_CALL on tool_call", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call",
      toolCallId: "tc-1",
      title: "Read file",
      kind: "read",
      status: "pending",
      rawInput: { path: "/tmp/x" },
    });
    expect(saveToolCall).toHaveBeenCalledWith(
      ctx.db,
      expect.objectContaining({
        id: "tc-1",
        messageId: "msg-1",
        name: "Read file",
        status: "pending_approval",
        category: "filesystem",
        args: { path: "/tmp/x" },
      })
    );
    expect(sent).toEqual([
      {
        channel: CH.SESSION_TOOL_CALL,
        payload: {
          session_id: "ai-1",
          tool_name: "Read file",
          tool_call_id: "tc-1",
          input: { path: "/tmp/x" },
        },
      },
    ]);
  });

  it("is idempotent for duplicate tool_call notifications", () => {
    const { ctx } = makeCtx();
    const update = {
      sessionUpdate: "tool_call",
      toolCallId: "tc-dup",
      title: "Tool",
      kind: "read",
      status: "pending",
      rawInput: {},
    };
    handleSessionUpdate(ctx, update);
    handleSessionUpdate(ctx, update);
    expect(saveToolCall).toHaveBeenCalledTimes(1);
  });

  it("updates tool status on tool_call_update with in_progress", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-2",
      status: "in_progress",
    });
    expect(updateToolCallStatus).toHaveBeenCalledWith(ctx.db, "tc-2", "approved");
    expect(sent).toEqual([]);
  });

  it("emits SESSION_TOOL_RESULT on completed tool_call_update", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-3",
      status: "completed",
      rawOutput: { ok: true },
    });
    expect(updateToolCallStatus).toHaveBeenCalledWith(
      ctx.db,
      "tc-3",
      "complete",
      { ok: true }
    );
    expect(sent).toEqual([
      {
        channel: CH.SESSION_TOOL_RESULT,
        payload: { session_id: "ai-1", tool_name: "tc-3", output: { ok: true } },
      },
    ]);
  });

  it("derives output text from content array when rawOutput is absent", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-4",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "Result " } },
        { type: "content", content: { type: "text", text: "body" } },
      ],
    });
    expect(updateToolCallStatus).toHaveBeenCalledWith(
      ctx.db,
      "tc-4",
      "complete",
      "Result body"
    );
    expect(sent[0].payload.output).toBe("Result body");
  });

  it("maps failed tool_call_update to error status", () => {
    const { ctx, sent } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call_update",
      toolCallId: "tc-5",
      status: "failed",
      rawOutput: "boom",
    });
    expect(updateToolCallStatus).toHaveBeenCalledWith(
      ctx.db,
      "tc-5",
      "error",
      "boom"
    );
    expect(sent[0].channel).toBe(CH.SESSION_TOOL_RESULT);
  });

  it("ignores tool_call_update without toolCallId", () => {
    const { ctx } = makeCtx();
    handleSessionUpdate(ctx, {
      sessionUpdate: "tool_call_update",
      status: "completed",
    });
    expect(updateToolCallStatus).not.toHaveBeenCalled();
  });

  it("silently ignores unsurfaced update kinds", () => {
    const { ctx, sent } = makeCtx();
    for (const kind of [
      "agent_thought_chunk",
      "user_message_chunk",
      "plan",
      "available_commands_update",
      "current_mode_update",
      "config_option_update",
      "session_info_update",
      "usage_update",
    ]) {
      handleSessionUpdate(ctx, { sessionUpdate: kind });
    }
    expect(sent).toEqual([]);
    expect(saveToolCall).not.toHaveBeenCalled();
    expect(updateToolCallStatus).not.toHaveBeenCalled();
  });

  it("warns on unknown sessionUpdate kind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ctx } = makeCtx();
    handleSessionUpdate(ctx, { sessionUpdate: "totally_new_event" });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
