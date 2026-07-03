import type { ProjectConfig } from "../../src/types/index";
import { requiresApproval, requestApproval } from "./approval";
import type { AppServerApprovalRequest } from "./codex-app-server";

// ─────────────────────────────────────────────────────────────────────────────
// Codex app-server approval bridge (#128, slice 4/4).
//
// The app-server issues server→client approval requests mid-turn. This bridge
// maps them onto AIchemist's existing approval gate (session/project allowlist →
// SESSION_APPROVAL_REQUIRED dialog → resolveApproval) so an interactive Codex
// turn prompts exactly like every other provider's gated tools — no new UI.
//
// Two request kinds (codex-rs/app-server/README.md):
//   - item/commandExecution/requestApproval → reply { decision: "approved"|"denied" }
//   - item/permissions/requestApproval       → reply { scope, permissions } (granted subset)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codex's `ReviewDecision` wire values for a command-execution approval reply.
 * (Experimental app-server protocol — if it shifts, this is the one place to
 * change the strings.)
 */
const REVIEW_DECISION = { approve: "approved", deny: "denied" } as const;

export interface CodexApprovalContext {
  sessionId: string;
  config: ProjectConfig;
  webContents: Electron.WebContents;
  /** Threaded through for safety; interactive turns (the only app-server users) leave it false. */
  nonInteractive: boolean;
}

/**
 * Resolve one app-server approval request into the JSON-RPC `result` to reply
 * with. Command approvals map to `{ decision }`; permission (filesystem) requests
 * map to a granted-subset `{ scope, permissions }` — v1 grants the full requested
 * subset on allow and none on deny (spike Phase 1). An unknown request kind is
 * denied safely.
 */
export async function resolveCodexApproval(
  req: AppServerApprovalRequest,
  ctx: CodexApprovalContext,
): Promise<unknown> {
  const params = (req.params ?? {}) as Record<string, unknown>;

  if (req.method === "item/commandExecution/requestApproval") {
    const command = extractCommand(params);
    const approved = await gate(ctx, "shell", "execute_bash", { command });
    return { decision: approved ? REVIEW_DECISION.approve : REVIEW_DECISION.deny };
  }

  if (req.method === "item/permissions/requestApproval") {
    const requested = (params.permissions ?? {}) as Record<string, unknown>;
    const writePaths = extractWritePaths(requested);
    const approved = await gate(ctx, "filesystem", "write_file", { paths: writePaths });
    // Grant the full requested subset on allow, none on deny (v1 — no partial UI).
    return { scope: "turn", permissions: approved ? requested : { fileSystem: { write: [] } } };
  }

  // Unrecognized approval kind — deny rather than risk auto-allowing.
  return { decision: REVIEW_DECISION.deny };
}

/**
 * Run one approval through the gate: already-trusted calls (session/project
 * allowlist) auto-allow with no prompt; otherwise prompt the user and await the
 * boolean decision.
 */
async function gate(
  ctx: CodexApprovalContext,
  category: "shell" | "filesystem",
  toolName: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  if (!requiresApproval(ctx.sessionId, ctx.config, category, toolName, args)) return true;
  return requestApproval(ctx.webContents, ctx.sessionId, toolName, args, {
    nonInteractive: ctx.nonInteractive,
  });
}

/**
 * Pull the command string out of a commandExecution approval request. The exact
 * field is experimental, so try the direct field, a nested item, and an argv
 * array before giving up (an empty command still gates — shell always prompts).
 */
function extractCommand(params: Record<string, unknown>): string {
  if (typeof params.command === "string") return params.command;
  if (Array.isArray(params.command)) return params.command.map((c) => String(c)).join(" ");
  const nested = (params.commandExecution ?? params.item) as { command?: unknown } | undefined;
  if (nested && typeof nested.command === "string") return nested.command;
  if (nested && Array.isArray(nested.command)) return nested.command.map((c) => String(c)).join(" ");
  return "";
}

/** Extract the requested filesystem write paths from a permissions request profile. */
function extractWritePaths(permissions: Record<string, unknown>): string[] {
  const fs = permissions.fileSystem as { write?: unknown } | undefined;
  return Array.isArray(fs?.write) ? fs.write.filter((p): p is string => typeof p === "string") : [];
}
