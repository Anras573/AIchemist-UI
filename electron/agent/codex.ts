import type { AgentProvider, AgentProviderParams } from "./provider";

/**
 * Placeholder provider entry for Codex.
 *
 * Ticket #118 wires the provider identity through the app so sessions can be
 * created and routed without unknown-provider failures. Full turn execution is
 * implemented in the dedicated Codex provider ticket.
 */
export const codexProvider: AgentProvider = {
  async run(_params: AgentProviderParams): Promise<string> {
    return "Codex provider is not available yet. Please switch this session to another provider.";
  },
  async probe(): Promise<{ ok: boolean; reason: string }> {
    return {
      ok: false,
      reason: "Codex provider is not configured or implemented yet.",
    };
  },
};
