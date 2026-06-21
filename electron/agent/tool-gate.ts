import type { Database } from "better-sqlite3";
import * as crypto from "crypto";
import type { ProjectConfig } from "../../src/types/index";
import { requestApproval, requiresApproval } from "./approval";
import type { ToolCategory } from "./approval";
import { saveToolCall, updateToolCallStatus } from "../sessions";
import type { TurnEmitter } from "./turn-emitter";
import type { NativeTranscriptRecorder } from "../native-transcript";

/** Result text returned to the model when the user rejects a tool call. */
export const TOOL_DENIED_MESSAGE = "Tool call denied by user.";

/**
 * Result text returned to the model when a gated tool is auto-denied in an
 * unattended (non-interactive) run. Distinct from {@link TOOL_DENIED_MESSAGE}
 * so a workflow transcript makes clear there was no user to deny it — the tool
 * simply wasn't in the project/workflow allowlist.
 */
export const TOOL_DENIED_UNATTENDED_MESSAGE =
  "Tool call denied automatically — unattended (non-interactive) run, tool not in allowlist.";

/**
 * Rules for mapping a provider's native tool names onto approval categories.
 * `shell` and `web` list the tool names in those categories; `filesystem`
 * optionally lists the write/edit tools that should gate. `normalize`
 * canonicalises a raw tool name before matching (e.g. Copilot lowercases).
 */
export interface NativeToolCategoryRules {
  shell: readonly string[];
  web: readonly string[];
  filesystem?: readonly string[];
  normalize?: (name: string) => string;
}

/**
 * Classify a native tool name into its approval category, or null for
 * read-only / unknown tools that never require approval. Centralises the
 * shell / web / filesystem mapping shared by the Claude and Copilot runners;
 * each passes its own provider-specific `rules`.
 */
export function classifyNativeTool(
  name: string,
  rules: NativeToolCategoryRules,
): ToolCategory | null {
  const normalized = rules.normalize ? rules.normalize(name) : name;
  if (rules.shell.includes(normalized)) return "shell";
  if (rules.web.includes(normalized)) return "web";
  if (rules.filesystem?.includes(normalized)) return "filesystem";
  return null;
}

/**
 * The per-turn state a gated tool execution needs. Provider tool contexts that
 * carry extra fields (clients, depth counters, …) satisfy this structurally.
 */
export interface GatedToolContext {
  db: Database;
  sessionId: string;
  messageId: string;
  projectConfig: ProjectConfig;
  emitter: TurnEmitter;
  /**
   * Optional native-provider transcript recorder. Self-driven providers
   * (Ollama, OpenAI-compatible) set this so tool calls/results are written to
   * the on-disk transcript that powers the Traces tab. Unset for the
   * SDK-backed providers, which get transcripts from their own SDKs.
   */
  recorder?: NativeTranscriptRecorder | null;
  /**
   * When true, the turn runs unattended (scheduled workflow): an un-allowlisted
   * gated tool is denied immediately rather than waiting on the approval prompt.
   * Trusted tools (project/session allowlist, `approval_mode: "none"`) never
   * reach the gate, so they run as usual. Unset for interactive user turns.
   */
  nonInteractive?: boolean;
}

/**
 * Run a provider tool through the shared approval gate:
 *
 * 1. emit SESSION_TOOL_CALL and persist the tool_call row
 * 2. prompt the user when `requiresApproval()` says the category is gated
 *    (category `"custom"` never gates — provider-internal tools like ask_user)
 * 3. execute the implementation
 * 4. persist the status transition and emit SESSION_TOOL_RESULT
 *
 * On implementation error the error message becomes the tool output by
 * default so the model can react to it; pass `onError: "throw"` to propagate
 * instead (no SESSION_TOOL_RESULT is emitted in that case).
 */
export async function runGatedTool(
  ctx: GatedToolContext,
  opts: {
    name: string;
    args: unknown;
    category: ToolCategory | "custom";
    impl: () => Promise<string>;
    onError?: "return" | "throw";
  },
): Promise<string> {
  const { db, sessionId, messageId, projectConfig, emitter, recorder, nonInteractive } = ctx;
  const { name, args, category, impl } = opts;

  const toolCallId = crypto.randomUUID();
  const needsGate =
    category !== "custom" && requiresApproval(sessionId, projectConfig, category, name, args);

  emitter.toolCall(toolCallId, name, args);
  recorder?.toolCall(toolCallId, name, args);
  saveToolCall(db, {
    id: toolCallId,
    messageId,
    name,
    args: (args ?? {}) as Record<string, unknown>,
    status: needsGate ? "pending_approval" : "approved",
    category,
  });

  if (needsGate) {
    const approved = await requestApproval(emitter.webContents, sessionId, name, args, { nonInteractive });
    if (!approved) {
      const deniedMessage = nonInteractive ? TOOL_DENIED_UNATTENDED_MESSAGE : TOOL_DENIED_MESSAGE;
      updateToolCallStatus(db, toolCallId, "rejected", deniedMessage);
      emitter.toolResult(name, deniedMessage);
      recorder?.toolResult(toolCallId, deniedMessage, true);
      return deniedMessage;
    }
    updateToolCallStatus(db, toolCallId, "approved");
  }

  try {
    const output = await impl();
    updateToolCallStatus(db, toolCallId, "complete", output);
    emitter.toolResult(name, output);
    recorder?.toolResult(toolCallId, output, false);
    return output;
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    updateToolCallStatus(db, toolCallId, "error", output);
    recorder?.toolResult(toolCallId, output, true);
    if (opts.onError === "throw") throw err;
    emitter.toolResult(name, output);
    return output;
  }
}
