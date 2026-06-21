// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../src/types/index";
import * as CH from "../ipc-channels";
import { resolveApproval } from "./approval";
import { runGatedTool, TOOL_DENIED_MESSAGE, TOOL_DENIED_UNATTENDED_MESSAGE } from "./tool-gate";
import { TurnEmitter } from "./turn-emitter";

function makeConfig(approvalMode: "all" | "none"): ProjectConfig {
  return {
    provider: "ollama",
    model: "test-model",
    approval_mode: approvalMode,
    approval_rules: [],
  } as unknown as ProjectConfig;
}

// Unique per-test session id keeps the module-level session allowlist in
// approval.ts from leaking between tests.
let sessionSeq = 0;

function makeCtx(approvalMode: "all" | "none") {
  const send = vi.fn();
  const sessionId = `s-gate-${++sessionSeq}`;
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
    sessionId,
    messageId: "m-1",
    projectConfig: makeConfig(approvalMode),
    emitter: new TurnEmitter({ send } as never, sessionId),
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

// ── Unattended (nonInteractive) execution — workflow autonomy ──────────────────
//
// A scheduled workflow run has nobody watching. `nonInteractive` makes an
// un-allowlisted gated tool deny immediately instead of hanging on the 5-min
// approval timeout, while a tool trusted by the project allowlist /
// approval_mode "none" (an "autonomous" workflow) still runs without prompting.

describe("runGatedTool — nonInteractive (unattended workflow run)", () => {
  it("denies an un-allowlisted gated tool immediately, without prompting", async () => {
    const { ctx, send, statusUpdates } = makeCtx("all");
    const impl = vi.fn();
    const output = await runGatedTool(
      { ...ctx, nonInteractive: true },
      { name: "write_file", args: { path: "a.txt" }, category: "filesystem", impl },
    );
    // A distinct message makes the unattended denial clear in transcripts.
    expect(output).toBe(TOOL_DENIED_UNATTENDED_MESSAGE);
    expect(impl).not.toHaveBeenCalled();
    // Never asks the (absent) renderer to approve.
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.anything());
    expect(statusUpdates).toEqual([{ status: "rejected", result: TOOL_DENIED_UNATTENDED_MESSAGE }]);
  });

  it('runs a tool trusted by approval_mode "none" (autonomous) without prompting', async () => {
    const { ctx, send } = makeCtx("none");
    const output = await runGatedTool(
      { ...ctx, nonInteractive: true },
      { name: "write_file", args: { path: "a.txt" }, category: "filesystem", impl: async () => "written" },
    );
    expect(output).toBe("written");
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.anything());
  });

  it("runs a project-allowlisted tool without prompting even under approval_mode all", async () => {
    const { ctx, send } = makeCtx("all");
    // An explicit per-workflow / project trust entry for this exact command.
    ctx.projectConfig = {
      ...ctx.projectConfig,
      allowed_tools: [{ tool_name: "execute_bash", command_pattern: "git" }],
    } as unknown as ProjectConfig;
    const output = await runGatedTool(
      { ...ctx, nonInteractive: true },
      { name: "execute_bash", args: { command: "git status" }, category: "shell", impl: async () => "clean" },
    );
    expect(output).toBe("clean");
    expect(send).not.toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.anything());
  });
});
