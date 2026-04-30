import * as crypto from "crypto";
import type { ProjectConfig } from "../../src/types/index";
import * as CH from "../ipc-channels";

// ── Approval gate ─────────────────────────────────────────────────────────────
//
// Single source of truth for all provider approval flows.
// Both Claude (MCP tools) and Copilot tool handlers resolve through this map.

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string; toolName: string; args: unknown; timer: ReturnType<typeof setTimeout> }
>();

/** Option-based approval (ACP). Resolution carries an `optionId` from the agent's
 * `permissionOptions` array, or `null` if cancelled. */
export interface PermissionOption {
  id: string;
  name: string;
  /** ACP `PermissionOptionKind`: "allow_once" | "allow_always" | "reject_once" | "reject_always". */
  kind: string;
}

const pendingChoiceApprovals = new Map<
  string,
  {
    resolve: (optionId: string | null) => void;
    sessionId: string;
    toolName: string;
    args: unknown;
    timer: ReturnType<typeof setTimeout>;
  }
>();

/**
 * Called by the IPC handler for `agent:approve-tool-call` to unblock a
 * waiting tool, regardless of which provider initiated the request.
 *
 * Resolves boolean-flavor approvals as well as option-flavor approvals
 * (the latter map `approved=true` → first allow option, `false` → first reject option;
 * for ACP callers prefer `resolvePermissionChoice` instead).
 */
export function resolveApproval(approvalId: string, approved: boolean): void {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    clearTimeout(pending.timer);
    pending.resolve(approved);
    pendingApprovals.delete(approvalId);
    return;
  }
  // Fallback for any stale ACP-flavor approval that arrived through the legacy path.
  const choice = pendingChoiceApprovals.get(approvalId);
  if (choice) {
    clearTimeout(choice.timer);
    choice.resolve(approved ? "__legacy_allow__" : null);
    pendingChoiceApprovals.delete(approvalId);
  }
}

/** Resolves an option-based (ACP) approval with the user-selected option id, or null on cancel. */
export function resolvePermissionChoice(approvalId: string, optionId: string | null): void {
  const choice = pendingChoiceApprovals.get(approvalId);
  if (choice) {
    clearTimeout(choice.timer);
    choice.resolve(optionId);
    pendingChoiceApprovals.delete(approvalId);
  }
}

/** Returns the stored tool name + args for a pending approval (used for allowlist recording). */
export function getPendingApprovalData(
  approvalId: string
): { sessionId: string; toolName: string; args: unknown } | null {
  const p = pendingApprovals.get(approvalId);
  if (p) return { sessionId: p.sessionId, toolName: p.toolName, args: p.args };
  const c = pendingChoiceApprovals.get(approvalId);
  return c ? { sessionId: c.sessionId, toolName: c.toolName, args: c.args } : null;
}

/**
 * Emits SESSION_APPROVAL_REQUIRED and suspends until the user approves/denies.
 * Auto-denies after 5 minutes if unanswered.
 */
export function requestApproval(
  webContents: Electron.WebContents,
  sessionId: string,
  toolName: string,
  input: unknown
): Promise<boolean> {
  const approvalId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        console.warn(`[approval] "${toolName}" (${approvalId}) timed out after 5 min — auto-denying`);
        pendingApprovals.delete(approvalId);
        resolve(false);
      }
    }, APPROVAL_TIMEOUT_MS);

    pendingApprovals.set(approvalId, { resolve, sessionId, toolName, args: input, timer });
    webContents.send(CH.SESSION_APPROVAL_REQUIRED, {
      session_id: sessionId,
      approval_id: approvalId,
      tool_name: toolName,
      input,
    });
  });
}

/**
 * Cancels all pending approvals for a session (e.g. on session deletion),
 * resolving each as denied and clearing the session allowlist.
 */
export function cancelSessionApprovals(sessionId: string): void {
  for (const [id, pending] of pendingApprovals.entries()) {
    if (pending.sessionId === sessionId) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      pendingApprovals.delete(id);
    }
  }
  for (const [id, choice] of pendingChoiceApprovals.entries()) {
    if (choice.sessionId === sessionId) {
      clearTimeout(choice.timer);
      choice.resolve(null);
      pendingChoiceApprovals.delete(id);
    }
  }
  sessionAllowlist.delete(sessionId);
}

/**
 * ACP-style approval — emits SESSION_APPROVAL_REQUIRED with a `permission_options`
 * array and suspends until the user picks an option (or cancels). Auto-cancels
 * after 5 minutes.
 *
 * Resolves with the chosen option id, or null if the user cancelled / timed out.
 */
export function requestPermissionChoice(
  webContents: Electron.WebContents,
  sessionId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  options: PermissionOption[]
): Promise<string | null> {
  const approvalId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingChoiceApprovals.has(approvalId)) {
        console.warn(`[approval] choice "${toolName}" (${approvalId}) timed out — cancelling`);
        pendingChoiceApprovals.delete(approvalId);
        resolve(null);
      }
    }, APPROVAL_TIMEOUT_MS);

    pendingChoiceApprovals.set(approvalId, { resolve, sessionId, toolName, args: input, timer });
    webContents.send(CH.SESSION_APPROVAL_REQUIRED, {
      session_id: sessionId,
      approval_id: approvalId,
      tool_call_id: toolCallId,
      tool_name: toolName,
      input,
      permission_options: options,
    });
  });
}

// ── Allowlists ────────────────────────────────────────────────────────────────

/** Session-scoped allowlist: maps sessionId → Set of tool fingerprints. */
const sessionAllowlist = new Map<string, Set<string>>();

/**
 * Computes a fingerprint for a tool call used for allowlist matching.
 * For execute_bash: "execute_bash:<first-word-of-command>"
 * For all other tools: "<tool_name>"
 */
export function computeFingerprint(toolName: string, args: unknown): string {
  if (toolName === "execute_bash") {
    const cmd = ((args as Record<string, unknown>).command as string | undefined) ?? "";
    const firstWord = cmd.trim().split(/\s+/)[0] ?? "";
    return `execute_bash:${firstWord}`;
  }
  return toolName;
}

/** Adds a tool call to the session-scoped allowlist so it won't prompt again this session. */
export function addToSessionAllowlist(sessionId: string, toolName: string, args: unknown): void {
  const fp = computeFingerprint(toolName, args);
  if (!sessionAllowlist.has(sessionId)) sessionAllowlist.set(sessionId, new Set());
  sessionAllowlist.get(sessionId)!.add(fp);
}

/** Returns true if this tool call is already approved for the current session. */
export function isSessionAllowed(sessionId: string, toolName: string, args: unknown): boolean {
  return sessionAllowlist.get(sessionId)?.has(computeFingerprint(toolName, args)) ?? false;
}

/** Returns true if this tool call matches an entry in the project's allowed_tools list. */
export function isProjectAllowed(config: ProjectConfig, toolName: string, args: unknown): boolean {
  return (config.allowed_tools ?? []).some((rule) => {
    if (rule.tool_name !== toolName) return false;
    if (!rule.command_pattern) return true;
    if (toolName === "execute_bash") {
      const cmd = ((args as Record<string, unknown>).command as string | undefined) ?? "";
      return cmd.trim().startsWith(rule.command_pattern);
    }
    return true;
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

/**
 * Full approval check: session allowlist → project allowlist → category rules.
 * Returns true if the tool call should be prompted for approval.
 */
export function requiresApproval(
  sessionId: string,
  config: ProjectConfig,
  category: ToolCategory,
  toolName: string,
  args: unknown
): boolean {
  if (isSessionAllowed(sessionId, toolName, args)) return false;
  if (isProjectAllowed(config, toolName, args)) return false;
  return needsApproval(config, category);
}
