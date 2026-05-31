import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import * as CH from "../ipc-channels";
import { createPlaceholderMessage, updateMessageContent, loadToolCallsForMessage, updateSessionStatus } from "../sessions";
import { claudeProvider } from "./claude";
import { copilotProvider } from "./copilot";
import { ollamaProvider } from "./ollama";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, AgentProvider> = {
  anthropic: claudeProvider,
  copilot: copilotProvider,
  ollama: ollamaProvider,
};

/** Look up a provider by name. Throws for unknown providers. */
export function getProvider(name: string): AgentProvider {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unsupported provider: ${name}`);
  return provider;
}

/** Register a new provider at runtime (e.g. in tests or for extensions). */
export function registerProvider(name: string, provider: AgentProvider): void {
  PROVIDERS[name] = provider;
}

// ── Agent turn dispatcher ─────────────────────────────────────────────────────

export async function runAgentTurn(params: {
  db: Database;
  sessionId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
  skills?: string[];
  skipPersistence?: boolean;
}): Promise<void> {
  const { db, sessionId, prompt, projectPath, projectConfig, webContents, agent, skills, skipPersistence } = params;

  webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "running" });
  updateSessionStatus(db, sessionId, "running");

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
  };

  try {
    const provider = getProvider(projectConfig.provider);
    const fullText = await provider.run(providerParams);

    if (skipPersistence) {
      // Side-effect-free run (e.g. PR description generation): discard the
      // placeholder and never emit SESSION_MESSAGE so no orphaned assistant
      // message appears in the chat history.
      db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
    } else {
      const toolCalls = loadToolCallsForMessage(db, placeholderMsg.id);
      if (fullText.trim() || toolCalls.length > 0) {
        updateMessageContent(db, placeholderMsg.id, fullText);
        webContents.send(CH.SESSION_MESSAGE, {
          session_id: sessionId,
          message: { ...placeholderMsg, content: fullText, tool_calls: toolCalls },
        });
      } else {
        db.prepare("DELETE FROM messages WHERE id = ?").run(placeholderMsg.id);
      }
    }

    webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "idle" });
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
    webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "error" });
    updateSessionStatus(db, sessionId, "error");
    throw err;
  }
}
