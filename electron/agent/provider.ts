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

  /** Graceful shutdown — called on app-quit if present. */
  stop?(): Promise<void>;
}
