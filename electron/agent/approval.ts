import * as crypto from "crypto";
import type { ProjectConfig } from "../../src/types/index";
import * as CH from "../ipc-channels";

// ── Approval gate ─────────────────────────────────────────────────────────────
//
// Single source of truth for all provider approval flows.
// Both Claude (MCP tools) and Copilot tool handlers resolve through this map.

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string }
>();

/**
 * Called by the IPC handler for `agent:approve-tool-call` to unblock a
 * waiting tool, regardless of which provider initiated the request.
 */
export function resolveApproval(approvalId: string, approved: boolean): void {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    pending.resolve(approved);
    pendingApprovals.delete(approvalId);
  }
}

/**
 * Emits SESSION_APPROVAL_REQUIRED and suspends until the user approves/denies.
 */
export function requestApproval(
  webContents: Electron.WebContents,
  sessionId: string,
  toolName: string,
  input: unknown
): Promise<boolean> {
  const approvalId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingApprovals.set(approvalId, { resolve, sessionId });
    webContents.send(CH.SESSION_APPROVAL_REQUIRED, {
      session_id: sessionId,
      approval_id: approvalId,
      tool_name: toolName,
      input,
    });
  });
}

// ── Approval policy ───────────────────────────────────────────────────────────

export type ToolCategory = "filesystem" | "shell" | "web";

/**
 * Returns true if the given tool category requires user approval under the
 * project's current approval_mode / approval_rules configuration.
 * Shell is always forced through approval regardless of config.
 */
export function needsApproval(
  config: ProjectConfig,
  category: ToolCategory
): boolean {
  if (category === "shell") return true;
  if (config.approval_mode === "all") return true;
  if (config.approval_mode === "none") return false;
  const rule = config.approval_rules.find((r) => r.tool_category === category);
  return rule?.policy === "always";
}
