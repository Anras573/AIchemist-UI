import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import * as CH from "../ipc-channels";
import { saveMessage } from "../sessions";
import { runClaudeAgentTurn } from "./claude";
import { runCopilotAgentTurn } from "./copilot";

export async function runAgentTurn(params: {
  db: Database;
  sessionId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
}): Promise<void> {
  const { db, sessionId, prompt, projectPath, projectConfig, webContents, agent } = params;

  webContents.send(CH.SESSION_STATUS, { session_id: sessionId, status: "running" });

  const row = db
    .prepare("SELECT sdk_session_id FROM sessions WHERE id = ?")
    .get(sessionId) as { sdk_session_id: string | null } | undefined;
  const sdkSessionId = row?.sdk_session_id ?? null;

  try {
    let fullText: string;

    switch (projectConfig.provider) {
      case "anthropic":
        fullText = await runClaudeAgentTurn({
          db,
          sessionId,
          sdkSessionId,
          prompt,
          projectPath,
          projectConfig,
          webContents,
          agent,
        });
        break;
      case "copilot":
        fullText = await runCopilotAgentTurn({
          sessionId,
          prompt,
          projectPath,
          projectConfig,
          webContents,
        });
        break;
      default:
        throw new Error(`Unsupported provider: ${projectConfig.provider}`);
    }

    if (fullText.trim()) {
      const savedMsg = saveMessage(db, {
        sessionId,
        role: "assistant",
        content: fullText,
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
