/**
 * Shared sub-agent delegation primitives for the self-driven providers
 * (Ollama, OpenAI-compatible). Both expose a `delegate_task` tool that runs a
 * self-contained sub-turn against another model with a fresh, depth-limited
 * context.
 *
 * Not applicable to Claude/Copilot — their SDKs delegate via SDK agents /
 * customAgents rather than an in-process hook, so they don't use this module.
 */

/** A delegated sub-agent runs at depth 1; it may not delegate further. */
export const MAX_DELEGATION_DEPTH = 1;

/** Sub-agents get a tighter tool-round budget than the orchestrator. */
export const SUB_AGENT_MAX_ROUNDS = 4;

export const SUB_AGENT_SYSTEM_PROMPT = [
  "You are a specialised sub-agent delegated a task by an orchestrating AI assistant.",
  "Complete the task using the available tools.",
  "Never invent file contents or command output — use tools to gather real data.",
  "Return a clear, concise result the orchestrating agent can act on directly.",
].join(" ");

/** Result text when a sub-agent exhausts its round budget without a final reply. */
export const SUB_AGENT_NO_RESPONSE =
  "(sub-agent reached tool round limit without producing a final response)";

/** Error thrown when a sub-agent tries to delegate past `MAX_DELEGATION_DEPTH`. */
export function delegationDepthLimitError(): Error {
  return new Error(
    `Delegation depth limit (${MAX_DELEGATION_DEPTH}) reached — sub-agents cannot delegate further`,
  );
}

/** Error thrown when a sub-agent calls `ask_user`, which is unavailable in delegated turns. */
export function askUserUnavailableError(): Error {
  return new Error(
    "ask_user is not available in delegated turns — the orchestrating agent must handle user interaction.",
  );
}
