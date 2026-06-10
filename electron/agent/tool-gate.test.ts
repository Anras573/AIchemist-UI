// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../src/types/index";
import * as CH from "../ipc-channels";
import { resolveApproval } from "./approval";
import { runGatedTool, TOOL_DENIED_MESSAGE } from "./tool-gate";
import { TurnEmitter } from "./turn-emitter";

function makeConfig(approvalMode: "all" | "none"): ProjectConfig {
  return {
    provider: "ollama",
    model: "test-model",
    approval_mode: approvalMode,
    approval_rules: [],
  } as unknown as ProjectConfig;
}

function makeCtx(approvalMode: "all" | "none") {
  const send = vi.fn();
  const statusUpdates: Array<{ status: string; result: unknown }> = [];
  const db = {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      run: vi.fn().mockImplementation((...args: unknown[]) => {
        if (sql.includes("UPDATE tool_calls")) {
          // updateToolCallStatus JSON-stringifies the result when present
          const result = sql.includes("result = ?") ? JSON.parse(args[1] as string) : undefined;
          statusUpdates.push({ status: args[0] as string, result });
        }
        return { changes: 1 };
      }),
    })),
  };
  const ctx = {
    db: db as never,
    sessionId: `s-${crypto.randomUUID()}`,
    messageId: "m-1",
    projectConfig: makeConfig(approvalMode),
    emitter: new TurnEmitter({ send } as never, "s-1"),
  };
  return { ctx, send, statusUpdates };
}

/** Resolve the pending approval that `send` captured. */
function answerApproval(send: ReturnType<typeof vi.fn>, approved: boolean): void {
  const call = send.mock.calls.find(([channel]) => channel === CH.SESSION_APPROVAL_REQUIRED);
  expect(call).toBeDefined();
  resolveApproval((call![1] as { approval_id: string }).approval_id, approved);
}

describe("runGatedTool", () => {
  it("runs ungated tools and persists complete status", async () => {
    const { ctx, send, statusUpdates } = makeCtx("none");
    const output = await runGatedTool(ctx, {
      name: "read_file",
      args: { path: "a.txt" },
      category: "filesystem",
      impl: async () => "contents",
    });
    expect(output).toBe("contents");
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({ tool_name: "read_file" }));
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({ output: "contents" }));
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.anything());
    expect(statusUpdates).toEqual([{ status: "complete", result: "contents" }]);
  });

  it("prompts for approval when gated and proceeds on approve", async () => {
    const { ctx, send, statusUpdates } = makeCtx("all");
    const pending = runGatedTool(ctx, {
      name: "write_file",
      args: { path: "a.txt" },
      category: "filesystem",
      impl: async () => "written",
    });
    await vi.waitFor(() => answerApproval(send, true));
    await expect(pending).resolves.toBe("written");
    expect(statusUpdates.map((u) => u.status)).toEqual(["approved", "complete"]);
  });

  it("returns the denial message and persists rejected on deny", async () => {
    const { ctx, send, statusUpdates } = makeCtx("all");
    const impl = vi.fn();
    const pending = runGatedTool(ctx, {
      name: "write_file",
      args: { path: "a.txt" },
      category: "filesystem",
      impl,
    });
    await vi.waitFor(() => answerApproval(send, false));
    await expect(pending).resolves.toBe(TOOL_DENIED_MESSAGE);
    expect(impl).not.toHaveBeenCalled();
    expect(statusUpdates).toEqual([{ status: "rejected", result: TOOL_DENIED_MESSAGE }]);
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({ output: TOOL_DENIED_MESSAGE }));
  });

  it('category "custom" never gates, even in approval_mode "all"', async () => {
    const { ctx, send } = makeCtx("all");
    const output = await runGatedTool(ctx, {
      name: "ask_user",
      args: {},
      category: "custom",
      impl: async () => "answer",
    });
    expect(output).toBe("answer");
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.anything());
  });

  it("returns the error message as tool output by default", async () => {
    const { ctx, send, statusUpdates } = makeCtx("none");
    const output = await runGatedTool(ctx, {
      name: "web_fetch",
      args: { url: "https://x" },
      category: "web",
      impl: async () => {
        throw new Error("boom");
      },
    });
    expect(output).toBe("boom");
    expect(statusUpdates).toEqual([{ status: "error", result: "boom" }]);
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({ output: "boom" }));
  });

  it('rethrows and skips SESSION_TOOL_RESULT with onError: "throw"', async () => {
    const { ctx, send, statusUpdates } = makeCtx("none");
    await expect(
      runGatedTool(ctx, {
        name: "web_fetch",
        args: { url: "https://x" },
        category: "web",
        onError: "throw",
        impl: async () => {
          throw new Error("boom");
        },
      })
    ).rejects.toThrow("boom");
    expect(statusUpdates).toEqual([{ status: "error", result: "boom" }]);
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.anything());
  });
});
