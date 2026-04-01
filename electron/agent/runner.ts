import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import * as CH from "../ipc-channels";
import { saveMessage } from "../sessions";
import { claudeProvider } from "./claude";
import { copilotProvider } from "./copilot";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS: Record<string, AgentProvider> = {
  anthropic: claudeProvider,
  copilot: copilotProvider,
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
}): Promise<void> {
  const { db, sessionId, prompt, projectPath, projectConfig, webContents, agent, skills } = params;

  webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "running" });

  const providerParams: AgentProviderParams = {
    db,
    sessionId,
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

    if (fullText.trim()) {
      const savedMsg = saveMessage(db, {
        sessionId,
        role: "assistant",
        content: fullText,
        agent,
      });
      webContents.send(CH.SESSION_MESSAGE, {
        session_id: sessionId,
        message: savedMsg,
      });
    }

    webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "idle" });
  } catch (err) {
    webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "error" });
    throw err;
  }
}
