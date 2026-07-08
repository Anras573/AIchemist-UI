import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import { createPlaceholderMessage, updateMessageContent, loadToolCallsForMessage, updateSessionStatus } from "../sessions";
import { recordUsage } from "../usage-ledger";
import { claudeProvider } from "./claude";
import { copilotProvider } from "./copilot";
import { ollamaProvider } from "./ollama";
import { openaiCompatProvider } from "./openai-compat";
import { codexProvider } from "./codex";
import type { AgentProvider, AgentProviderParams } from "./provider";
import { TurnEmitter, clearLastUsage, getLastUsage } from "./turn-emitter";

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, AgentProvider> = {
  anthropic: claudeProvider,
  copilot: copilotProvider,
  ollama: ollamaProvider,
  "openai-compatible": openaiCompatProvider,
  codex: codexProvider,
};

/** Look up a provider by name. Throws for unknown providers. */
export function getProvider(name: string): AgentProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unsupported provider: ${name}`);
  return provider;
}

/** Look up a provider by name, returning null for unknown providers. */
export function getProviderOrNull(name: string): AgentProvider | null {
  return PROVIDERS[name] ?? null;
}

/** Register a new provider at runtime (e.g. in tests or for extensions). */
export function registerProvider(name: string, provider: AgentProvider): void {
  PROVIDERS[name] = provider;
}

/** Names of all registered providers (e.g. to iterate stop()/probe() hooks). */
export function getProviderNames(): string[] {
  return Object.keys(PROVIDERS);
}

// ── Agent turn dispatcher ─────────────────────────────────────────────────────

export async function runAgentTurn(params: {
  db: Database;
  sessionId: string;
  projectId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
  skills?: string[];
  skipPersistence?: boolean;
  nonInteractive?: boolean;
}): Promise<void> {
  const { db, sessionId, projectId, prompt, projectPath, projectConfig, webContents, agent, skills, skipPersistence, nonInteractive } =
    params;

  const emitter = new TurnEmitter(webContents, sessionId);
  emitter.status("running");
  updateSessionStatus(db, sessionId, "running");
  // Discard any usage reading left over from a prior turn on this session so a
  // provider that never calls usage() this turn doesn't record stale numbers.
  clearLastUsage(sessionId);

  // Create a placeholder assistant message that tool calls can FK-reference
  const placeholderMsg = createPlaceholderMessage(db, { sessionId, agent });

  const providerParams: AgentProviderParams = {
    db,
    sessionId,
    messageId: placeholderMsg.id,
    prompt,
    projectPath,
    projectConfig,
    webContents,
    agent,
    skills,
    // When skipPersistence is enabled (e.g. PR description generation), disable
    // all tool access so the model cannot perform filesystem/shell side-effects.
    noTools: !!skipPersistence,
    nonInteractive,
  };

  try {
    const provider = getProvider(projectConfig.provider);
    const fullText = await provider.run(providerParams);

    if (skipPersistence) {
      // No-persistence run (e.g. PR description generation): discard the
      // placeholder and never emit SESSION_MESSAGE so no orphaned assistant
      // message appears in the chat history.
      db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
    } else {
      const toolCalls = loadToolCallsForMessage(db, placeholderMsg.id);
      if (fullText.trim() || toolCalls.length > 0) {
        updateMessageContent(db, placeholderMsg.id, fullText);
        emitter.message({ ...placeholderMsg, content: fullText, tool_calls: toolCalls });
      } else {
        db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
      }
    }

    // Write one usage-ledger row per completed turn (every provider streams
    // through the same TurnEmitter.usage(), so this is a single seam covering
    // all of them). Fail-safe — a ledger write error must never break a turn.
    try {
      recordUsage(db, {
        sessionId,
        projectId,
        provider: projectConfig.provider,
        model: projectConfig.model || null,
        usage: getLastUsage(sessionId),
      });
    } catch (err) {
      console.error(`[usage-ledger] Failed to record usage for session ${sessionId}:`, err);
    } finally {
      clearLastUsage(sessionId);
    }

    emitter.status("idle");
    updateSessionStatus(db, sessionId, "idle");
  } catch (err) {
    if (skipPersistence) {
      db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
    } else {
      const toolCalls = loadToolCallsForMessage(db, placeholderMsg.id);
      if (toolCalls.length === 0) {
        db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
      }
    }
    clearLastUsage(sessionId);
    emitter.status("error");
    updateSessionStatus(db, sessionId, "error");
    throw err;
  }
}
