import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import { getProjectConfig, saveProjectConfig } from "../projects";
import { getProvider } from "../agent/runner";
import {
  resolveApproval,
  getPendingApprovalData,
  addToSessionAllowlist,
  computeFingerprint,
} from "../agent/approval";
import { resolveQuestion } from "../agent/question";
import { listSkills } from "../skills-discovery";
import { handle } from "./handle";
import {
  type TurnQueueContext,
  submitTurn,
  recoverQueue,
} from "./agent-turn-queue";

// The per-session turn queue / `activeTurns` machinery and the headless turn
// entry point live in `./agent-turn-queue`, shared with the workflow scheduler.
// These handlers are thin wrappers that build a TurnQueueContext and delegate.
export { cleanupSessionQueueState } from "./agent-turn-queue";

// ── Handler registration ──────────────────────────────────────────────────────

export function registerAgentHandlers(
  db: Database,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  const queue: TurnQueueContext = { db, activeTurns, getMainWindow };

  handle(CH.AGENT_SEND, (_event, args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[]; skipPersistence?: boolean; messageId?: string }) =>
    submitTurn(queue, args.sessionId, {
      prompt: args.prompt,
      agent: args.agent,
      oneshotSkills: args.oneshotSkills,
      skipPersistence: args.skipPersistence,
      messageId: args.messageId,
    })
  );

  handle(CH.AGENT_QUEUE_RECOVERY, (_event, args: { sessionId: string; action: "retry" | "skip" | "clear" }) =>
    recoverQueue(queue, args.sessionId, args.action)
  );

  handle(CH.GET_COPILOT_MODELS, async () => (await getProvider("copilot").listModels?.()) ?? []);
  handle(CH.GET_OLLAMA_MODELS, async () => (await getProvider("ollama").listModels?.()) ?? []);
  handle(CH.GET_OPENAI_COMPAT_MODELS, async () => (await getProvider("openai-compatible").listModels?.()) ?? []);
  handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return (await getProvider("anthropic").listAgents?.(projectPath)) ?? [];
  });
  handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return (await getProvider("copilot").listAgents?.(projectPath)) ?? [];
  });

  handle(CH.LIST_SKILLS, (_event, args: string | { projectPath: string; provider?: string }) => {
    const projectPath = typeof args === "string" ? args : args.projectPath;
    const provider = typeof args === "string" ? undefined : args.provider;
    return listSkills(projectPath, provider);
  });

  handle(
    CH.APPROVE_TOOL_CALL,
    (_event, args: {
      sessionId: string;
      approvalId: string;
      approved: boolean;
      scope?: "once" | "session" | "project";
      projectId?: string;
    }) => {
      if (args.approved && args.scope && args.scope !== "once") {
        const data = getPendingApprovalData(args.approvalId);
        if (data) {
          if (args.scope === "session") {
            addToSessionAllowlist(data.sessionId, data.toolName, data.args);
          } else if (args.scope === "project" && args.projectId) {
            const config = getProjectConfig(db, args.projectId);
            const fp = computeFingerprint(data.toolName, data.args);
            const pattern = data.toolName === "execute_bash"
              ? fp.replace("execute_bash:", "") || undefined
              : undefined;
            const existing = config.allowed_tools ?? [];
            const alreadyExists = existing.some(
              (t) => t.tool_name === data.toolName && t.command_pattern === pattern
            );
            if (!alreadyExists) {
              config.allowed_tools = [...existing, { tool_name: data.toolName, command_pattern: pattern }];
              saveProjectConfig(db, args.projectId, config);
            }
          }
        }
      }
      resolveApproval(args.approvalId, args.approved);
    }
  );

  handle(
    CH.ANSWER_QUESTION,
    (_event, args: { questionId: string; answer: string }) => {
      resolveQuestion(args.questionId, args.answer);
    }
  );
}
