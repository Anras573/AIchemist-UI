import type { Database } from "better-sqlite3";
import type { AgentInfo, ProjectConfig } from "../../src/types/index";

// ── Provider interface ────────────────────────────────────────────────────────

export interface AgentProviderParams {
  db: Database;
  sessionId: string;
  messageId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  /** Optional sub-agent name (provider-specific). */
  agent?: string;
  /** Active skill names to inject into the system prompt. */
  skills?: string[];
  /**
   * When true, the provider must not register or invoke any tools (filesystem,
   * shell, web, MCP, etc.). Use for text-only generation turns such as PR draft
   * generation where side-effects must be prevented.
   */
  noTools?: boolean;
  /**
   * When true, the turn runs unattended (e.g. a scheduled workflow) — there is
   * no user watching to answer an `ask_user` question or approve a gated tool.
   * The approval/question paths take an immediate-resolve branch (deny/empty)
   * instead of waiting on the 5-minute timeout. Un-allowlisted approvals are
   * denied; `autonomous` workflows pre-trust tools via the project allowlist /
   * `approval_mode: "none"`, so those never reach the gate. Additive — omitted
   * (falsy) for interactive user turns, which keep today's behavior.
   */
  nonInteractive?: boolean;
}

/**
 * Contract that every agent provider must satisfy.
 *
 * `run()` is the only required method. All other capabilities are optional;
 * callers should check for their presence before invoking them.
 */
export interface AgentProvider {
  /** Execute one agent turn, streaming IPC events via webContents. Returns the full response text. */
  run(params: AgentProviderParams): Promise<string>;

  /** List models available for this provider. */
  listModels?(): Promise<Array<{ id: string; name: string }>>;

  /** List available sub-agents (e.g. Claude sub-agents). */
  listAgents?(projectPath: string): Promise<AgentInfo[]>;

  /**
   * Availability probe for the new-session UI. When present, `probeAll()` in
   * provider-probe.ts uses it instead of a built-in probe — implement it on a
   * new provider so no provider-probe.ts changes are needed. Caching is the
   * provider's responsibility.
   */
  probe?(opts?: { force?: boolean }): Promise<{ ok: boolean; reason?: string; durationMs?: number }>;

  /** Graceful shutdown — called on app-quit for every registered provider. */
  stop?(): Promise<void>;
}
