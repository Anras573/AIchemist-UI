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
    throw new Error("Codex provider execution is not implemented yet.");
  },
};
