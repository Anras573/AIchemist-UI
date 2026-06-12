import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import { getSession } from "../sessions";
import { listProjects, getProjectConfig, saveProjectConfig } from "../projects";
import { runAgentTurn, getProvider } from "../agent/runner";
import {
  resolveApproval,
  getPendingApprovalData,
  addToSessionAllowlist,
  computeFingerprint,
} from "../agent/approval";
import { resolveQuestion } from "../agent/question";
import { getIssue } from "../github";
import { listSkills } from "../skills-discovery";
import { handle } from "./handle";

// ── Message queue ─────────────────────────────────────────────────────────────

interface QueuedTurn {
  prompt: string;
  agent?: string;
  oneshotSkills?: string[];
  skipPersistence?: boolean;
  messageId?: string;
}

// Per-session FIFO queues for turns submitted while a turn is already running
const sessionQueues = new Map<string, QueuedTurn[]>();
// Per-session paused queues — set when a queued turn fails, cleared on recovery
const pausedQueues = new Map<string, { failed: QueuedTurn; remaining: QueuedTurn[] }>();

async function executeAgentTurn(
  db: Database,
  sessionId: string,
  turn: QueuedTurn,
  win: BrowserWindow
): Promise<void> {
  const session = getSession(db, sessionId);
  const project = listProjects(db).find((p) => p.id === session.project_id);
  if (!project) throw new Error(`Project not found for session ${sessionId}`);

  const effectiveConfig = {
    ...project.config,
    provider: session.provider ?? project.config.provider,
    model: session.model ?? project.config.model,
  };
  const sessionSkills = session.skills ?? [];
  const oneshotSkills = turn.oneshotSkills ?? [];
  const allSkills = [...new Set([...sessionSkills, ...oneshotSkills])];
  const agent = turn.agent ?? session.agent ?? undefined;
  const skills = allSkills.length > 0 ? allSkills : undefined;

  let prompt = turn.prompt;
  if (session.github_issue_number != null && session.messages.length === 1) {
    const projectPath = session.workspace_path ?? project.path;
    try {
      const result = await getIssue({ projectPath, issueNumber: session.github_issue_number });
      if ("issue" in result) {
        const { issue } = result;
        const labelStr = issue.labels?.length ? issue.labels.join(", ") : "none";
        const bodyStr = issue.body ? `\n\n${issue.body}` : "";
        prompt = `GitHub Issue #${issue.number}: ${issue.title}\nLabels: ${labelStr}${bodyStr}\n\n---\n\n${turn.prompt}`;
      } else {
        console.warn(`[issue-context] Issue #${session.github_issue_number} context unavailable: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[issue-context] Failed to fetch issue #${session.github_issue_number}:`, err);
    }
  }

  await runAgentTurn({
    db,
    sessionId,
    prompt,
    projectPath: session.workspace_path ?? project.path,
    projectConfig: effectiveConfig,
    webContents: win.webContents,
    agent,
    skills,
    skipPersistence: turn.skipPersistence,
  });
}

// Starts draining the next queued turn. Must be called only when activeTurns
// does NOT contain sessionId — this function re-adds it synchronously before
// any await so no concurrent AGENT_SEND can slip through.
function drainNextQueued(
  db: Database,
  sessionId: string,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  const queue = sessionQueues.get(sessionId);
  if (!queue || queue.length === 0) {
    sessionQueues.delete(sessionId);
    return;
  }

  const win = getMainWindow();
  if (!win) {
    // Window is unavailable (shutdown/reload) — clear the queue so subsequent
    // AGENT_SEND calls are not permanently wedged by sessionQueues.has().
    sessionQueues.delete(sessionId);
    return;
  }

  const next = queue.shift()!;
  if (queue.length === 0) sessionQueues.delete(sessionId);

  win.webContents.send(CH.SESSION_QUEUE_TURN_START, {
    session_id: sessionId,
    message_id: next.messageId,
  });

  // Re-claim activeTurns synchronously before any await to prevent races.
  activeTurns.add(sessionId);

  executeAgentTurn(db, sessionId, next, win)
    .then(() => {
      activeTurns.delete(sessionId);
      drainNextQueued(db, sessionId, activeTurns, getMainWindow);
    })
    .catch((err: unknown) => {
      activeTurns.delete(sessionId);
      console.error(`[queue] queued turn failed for session ${sessionId} (messageId=${next.messageId ?? "none"}):`, err);
      const remaining = [...(sessionQueues.get(sessionId) ?? [])];
      sessionQueues.delete(sessionId);
      const w = getMainWindow();
      if (w) {
        // Pause the queue and surface a recovery prompt.
        pausedQueues.set(sessionId, { failed: next, remaining });
        w.webContents.send(CH.SESSION_QUEUE_RECOVERY_REQUIRED, {
          session_id: sessionId,
          remaining_count: remaining.length,
          failed_message_id: next.messageId,
        });
      }
      // If no window: don't set pausedQueues — that would wedge future sends behind
      // a paused state the renderer can never recover from. Queued items are lost but
      // the session is unblocked. Badges clear on next renderer load (store resets).
    });
}

/** Called by DELETE_SESSION to purge all queue state for a deleted session. */
export function cleanupSessionQueueState(sessionId: string): void {
  sessionQueues.delete(sessionId);
  pausedQueues.delete(sessionId);
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerAgentHandlers(
  db: Database,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  handle(CH.AGENT_SEND, async (_event, args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[]; skipPersistence?: boolean; messageId?: string }) => {
    const win = getMainWindow();
    if (!win) throw new Error("No window available");

    const turn: QueuedTurn = {
      prompt: args.prompt,
      agent: args.agent,
      oneshotSkills: args.oneshotSkills,
      skipPersistence: args.skipPersistence,
      messageId: args.messageId,
    };

    const isBusy = activeTurns.has(args.sessionId)
      || sessionQueues.has(args.sessionId)
      || pausedQueues.has(args.sessionId);
    if (isBusy) {
      // Only real chat messages (already saved to SQLite, not skipPersistence) are
      // safe to queue. Other callers (e.g. PR description generator) expect the IPC
      // call to represent the full lifetime of the turn and don't handle { queued: true }.
      if (!args.messageId || args.skipPersistence) {
        throw new Error(`Session ${args.sessionId} is busy — cannot queue non-chat turns`);
      }
      // Enqueue and return immediately.
      const existing = sessionQueues.get(args.sessionId) ?? [];
      sessionQueues.set(args.sessionId, [...existing, turn]);
      return { queued: true };
    }

    activeTurns.add(args.sessionId);
    let succeeded = false;
    try {
      await executeAgentTurn(db, args.sessionId, turn, win);
      succeeded = true;
    } finally {
      activeTurns.delete(args.sessionId);
      if (succeeded) {
        // Drain queued turns (re-adds to activeTurns synchronously if queue is non-empty).
        drainNextQueued(db, args.sessionId, activeTurns, getMainWindow);
      } else {
        // Direct turn failed — if messages were queued behind it, surface a recovery
        // prompt instead of silently dropping them (which leaves permanent "Queued" badges).
        const queued = [...(sessionQueues.get(args.sessionId) ?? [])];
        sessionQueues.delete(args.sessionId);
        if (queued.length > 0) {
          const w = getMainWindow();
          if (w) {
            pausedQueues.set(args.sessionId, { failed: turn, remaining: queued });
            w.webContents.send(CH.SESSION_QUEUE_RECOVERY_REQUIRED, {
              session_id: args.sessionId,
              remaining_count: queued.length,
              failed_message_id: turn.messageId,
            });
          }
          // If no window: don't set pausedQueues — that would wedge future sends
          // behind a paused state the renderer can never recover from.
        }
      }
    }

    return { queued: false };
  });

  handle(CH.AGENT_QUEUE_RECOVERY, (_event, args: { sessionId: string; action: "retry" | "skip" | "clear" }) => {
    const paused = pausedQueues.get(args.sessionId);
    if (!paused) return;

    if (args.action === "clear") {
      pausedQueues.delete(args.sessionId);
      sessionQueues.delete(args.sessionId);
      return;
    }

    const recoveryTurns: QueuedTurn[] =
      args.action === "retry"
        ? [paused.failed, ...paused.remaining]
        : paused.remaining;

    // Preserve any new turns enqueued while the queue was paused.
    const newlyQueued = sessionQueues.get(args.sessionId) ?? [];
    const mergedQueue = [...recoveryTurns, ...newlyQueued];

    pausedQueues.delete(args.sessionId);

    if (mergedQueue.length === 0) return;

    sessionQueues.set(args.sessionId, mergedQueue);

    if (!activeTurns.has(args.sessionId)) {
      drainNextQueued(db, args.sessionId, activeTurns, getMainWindow);
    }
    // If a turn is somehow already running, drainNextQueued fires when it finishes.
  });

  handle(CH.GET_COPILOT_MODELS, () => getProvider("copilot").listModels?.());
  handle(CH.GET_OLLAMA_MODELS, () => getProvider("ollama").listModels?.());
  handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getProvider("anthropic").listAgents?.(projectPath);
  });
  handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return getProvider("copilot").listAgents?.(projectPath);
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
