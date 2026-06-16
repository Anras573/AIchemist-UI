import type { Database } from "better-sqlite3";
import * as crypto from "crypto";
import type { ProjectConfig } from "../../src/types/index";
import { requestApproval, requiresApproval } from "./approval";
import type { ToolCategory } from "./approval";
import { saveToolCall, updateToolCallStatus } from "../sessions";
import type { TurnEmitter } from "./turn-emitter";

/** Result text returned to the model when the user rejects a tool call. */
export const TOOL_DENIED_MESSAGE = "Tool call denied by user.";

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
  const { db, sessionId, messageId, projectConfig, emitter } = ctx;
  const { name, args, category, impl } = opts;

  const toolCallId = crypto.randomUUID();
  const needsGate =
    category !== "custom" && requiresApproval(sessionId, projectConfig, category, name, args);

  emitter.toolCall(toolCallId, name, args);
  saveToolCall(db, {
    id: toolCallId,
    messageId,
    name,
    args: (args ?? {}) as Record<string, unknown>,
    status: needsGate ? "pending_approval" : "approved",
    category,
  });

  if (needsGate) {
    const approved = await requestApproval(emitter.webContents, sessionId, name, args);
    if (!approved) {
      updateToolCallStatus(db, toolCallId, "rejected", TOOL_DENIED_MESSAGE);
      emitter.toolResult(name, TOOL_DENIED_MESSAGE);
      return TOOL_DENIED_MESSAGE;
    }
    updateToolCallStatus(db, toolCallId, "approved");
  }

  try {
    const output = await impl();
    updateToolCallStatus(db, toolCallId, "complete", output);
    emitter.toolResult(name, output);
    return output;
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err);
    updateToolCallStatus(db, toolCallId, "error", output);
    if (opts.onError === "throw") throw err;
    emitter.toolResult(name, output);
    return output;
  }
}
