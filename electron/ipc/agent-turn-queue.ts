import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import { getSession } from "../sessions";
import { listProjects } from "../projects";
import { runAgentTurn } from "../agent/runner";
import { getIssue } from "../github";

// ── Shared per-session turn queue ───────────────────────────────────────────────
//
// The turn lifecycle used to live inside `agent-handlers.ts`, coupled to a live
// renderer `webContents`. It is extracted here so both the IPC handler and the
// (future) workflow scheduler can drive a turn through the *same* per-session
// FIFO queue / `activeTurns` machinery — a scheduled run is just another
// `QueuedTurn` and can never collide with a user-driven turn on the same session.
//
// The path also tolerates a missing renderer: a turn submitted with no window
// still runs and persists its results to SQLite, it simply emits nothing.

export interface QueuedTurn {
  prompt: string;
  agent?: string;
  oneshotSkills?: string[];
  skipPersistence?: boolean;
  messageId?: string;
  /**
   * When true, the turn runs unattended (scheduled workflow run): `ask_user`
   * and un-allowlisted approvals resolve immediately instead of hanging. Unset
   * for user-driven turns from the renderer.
   */
  nonInteractive?: boolean;
}

/**
 * Everything the queue needs that lives outside this module: the DB, the
 * app-wide `activeTurns` set (shared with the session handlers), and a
 * late-bound window getter that returns `null` when no renderer is attached.
 */
export interface TurnQueueContext {
  db: Database;
  activeTurns: Set<string>;
  getMainWindow: () => BrowserWindow | null;
}

// Per-session FIFO queues for turns submitted while a turn is already running
const sessionQueues = new Map<string, QueuedTurn[]>();
// Per-session paused queues — set when a queued turn fails, cleared on recovery
const pausedQueues = new Map<string, { failed: QueuedTurn; remaining: QueuedTurn[] }>();

// A no-op WebContents for headless turns (no renderer attached). The turn still
// runs and persists to SQLite — it just emits nothing. Using a null-object here
// avoids threading `WebContents | null` through the runner, every provider, and
// the approval/question paths (all of which only ever call `.send`).
const noopWebContents = { send: () => {} } as unknown as Electron.WebContents;

export async function executeAgentTurn(
  ctx: TurnQueueContext,
  sessionId: string,
  turn: QueuedTurn,
  win: BrowserWindow | null
): Promise<void> {
  const { db } = ctx;
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
    // Headless when no window is attached: emits nothing, still persists.
    webContents: win?.webContents ?? noopWebContents,
    agent,
    skills,
    skipPersistence: turn.skipPersistence,
    // Force non-interactive whenever no renderer is attached: a null window can
    // never answer an approval / ask_user prompt, so without this a gated tool
    // would hang out the full 5-min timeout before auto-denying. A workflow's
    // own `interactive` autonomy only takes effect while a window IS attached
    // (a babysat reuse session or a focused "Run now").
    nonInteractive: turn.nonInteractive || win === null,
  });
}

// Starts draining the next queued turn. Must be called only when activeTurns
// does NOT contain sessionId — this function re-adds it synchronously before
// any await so no concurrent AGENT_SEND can slip through.
export function drainNextQueued(ctx: TurnQueueContext, sessionId: string): void {
  const { activeTurns, getMainWindow } = ctx;
  const queue = sessionQueues.get(sessionId);
  if (!queue || queue.length === 0) {
    sessionQueues.delete(sessionId);
    return;
  }

  const next = queue.shift()!;
  if (queue.length === 0) sessionQueues.delete(sessionId);

  // The window may be gone (shutdown/reload) or never attached (scheduled run).
  // Either way the turn still runs headlessly — we just skip the renderer emit.
  const win = getMainWindow();
  win?.webContents.send(CH.SESSION_QUEUE_TURN_START, {
    session_id: sessionId,
    message_id: next.messageId,
  });

  // Re-claim activeTurns synchronously before any await to prevent races.
  activeTurns.add(sessionId);

  executeAgentTurn(ctx, sessionId, next, win)
    .then(() => {
      activeTurns.delete(sessionId);
      drainNextQueued(ctx, sessionId);
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

/**
 * Core of `AGENT_SEND`: run the turn now if the session is idle, otherwise queue
 * it (chat messages only). Requires a live window — user-driven turns always
 * originate from the renderer. Behaviour is identical to the old in-handler code.
 */
export async function submitTurn(
  ctx: TurnQueueContext,
  sessionId: string,
  turn: QueuedTurn
): Promise<{ queued: boolean }> {
  const { activeTurns, getMainWindow } = ctx;
  const win = getMainWindow();
  if (!win) throw new Error("No window available");

  const isBusy = activeTurns.has(sessionId)
    || sessionQueues.has(sessionId)
    || pausedQueues.has(sessionId);
  if (isBusy) {
    // Only real chat messages (already saved to SQLite, not skipPersistence) are
    // safe to queue. Other callers (e.g. PR description generator) expect the IPC
    // call to represent the full lifetime of the turn and don't handle { queued: true }.
    if (!turn.messageId || turn.skipPersistence) {
      throw new Error(`Session ${sessionId} is busy — cannot queue non-chat turns`);
    }
    // Enqueue and return immediately.
    const existing = sessionQueues.get(sessionId) ?? [];
    sessionQueues.set(sessionId, [...existing, turn]);
    return { queued: true };
  }

  activeTurns.add(sessionId);
  let succeeded = false;
  try {
    await executeAgentTurn(ctx, sessionId, turn, win);
    succeeded = true;
  } finally {
    activeTurns.delete(sessionId);
    if (succeeded) {
      // Drain queued turns (re-adds to activeTurns synchronously if queue is non-empty).
      drainNextQueued(ctx, sessionId);
    } else {
      // Direct turn failed — if messages were queued behind it, surface a recovery
      // prompt instead of silently dropping them (which leaves permanent "Queued" badges).
      const queued = [...(sessionQueues.get(sessionId) ?? [])];
      sessionQueues.delete(sessionId);
      if (queued.length > 0) {
        const w = getMainWindow();
        if (w) {
          pausedQueues.set(sessionId, { failed: turn, remaining: queued });
          w.webContents.send(CH.SESSION_QUEUE_RECOVERY_REQUIRED, {
            session_id: sessionId,
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
}

/**
 * Whether a session currently has a turn running, queued, or paused awaiting
 * recovery. Used by the workflow scheduler's overlap policy: a fire whose target
 * session is busy is recorded as `skipped` rather than stacked.
 */
export function isSessionBusy(ctx: TurnQueueContext, sessionId: string): boolean {
  return (
    ctx.activeTurns.has(sessionId) ||
    sessionQueues.has(sessionId) ||
    pausedQueues.has(sessionId)
  );
}

/**
 * Run a turn to completion *now*, exclusively, awaiting its result. Used by the
 * workflow scheduler so it can record the run's terminal status.
 *
 * If the session is already busy (a turn running, queued, or paused) it returns
 * `{ skipped: true }` without running — the scheduler's overlap policy records the
 * fire as `skipped` rather than stacking runs. Otherwise it claims the session,
 * awaits the turn (headless when no window is attached), drains any follow-on
 * queue on success, and resolves `{ skipped: false }`; it rejects if the turn
 * throws so the caller can record an `error` run.
 */
export async function runTurnExclusive(
  ctx: TurnQueueContext,
  sessionId: string,
  turn: QueuedTurn
): Promise<{ skipped: boolean }> {
  const { activeTurns, getMainWindow } = ctx;
  if (isSessionBusy(ctx, sessionId)) return { skipped: true };

  activeTurns.add(sessionId);
  let succeeded = false;
  try {
    await executeAgentTurn(ctx, sessionId, turn, getMainWindow());
    succeeded = true;
    return { skipped: false };
  } finally {
    activeTurns.delete(sessionId);
    // Only drain follow-on queued turns after a clean run. On failure the error
    // propagates out of this finally to the caller (the scheduler records it).
    if (succeeded) drainNextQueued(ctx, sessionId);
  }
}

/**
 * Programmatically enqueue a turn (e.g. from the workflow scheduler). Respects
 * `activeTurns` + the FIFO queue so a scheduled run never collides with a
 * user-driven turn on the same session. Unlike {@link submitTurn} it needs no
 * window: a turn submitted with no renderer attached still runs and persists to
 * SQLite, emitting nothing.
 *
 * Returns whether the turn was queued behind a running turn (`true`) or started
 * immediately (`false`). The run itself proceeds asynchronously through the same
 * drain machinery, so this never blocks the caller.
 */
export function enqueueTurn(
  ctx: TurnQueueContext,
  sessionId: string,
  turn: QueuedTurn
): { queued: boolean } {
  const { activeTurns } = ctx;
  const isBusy = activeTurns.has(sessionId)
    || sessionQueues.has(sessionId)
    || pausedQueues.has(sessionId);
  if (isBusy) {
    const existing = sessionQueues.get(sessionId) ?? [];
    sessionQueues.set(sessionId, [...existing, turn]);
    return { queued: true };
  }

  // Idle — seed the queue with this turn and drain it. drainNextQueued claims
  // activeTurns synchronously before any await, runs the turn (headless when no
  // window), and chains any follow-on queued turns / failure recovery.
  sessionQueues.set(sessionId, [turn]);
  drainNextQueued(ctx, sessionId);
  return { queued: false };
}

/**
 * Core of `AGENT_QUEUE_RECOVERY`: resume, skip, or clear a queue paused by a
 * failed turn. Behaviour is identical to the old in-handler code.
 */
export function recoverQueue(
  ctx: TurnQueueContext,
  sessionId: string,
  action: "retry" | "skip" | "clear"
): void {
  const { activeTurns } = ctx;
  const paused = pausedQueues.get(sessionId);
  if (!paused) return;

  if (action === "clear") {
    pausedQueues.delete(sessionId);
    sessionQueues.delete(sessionId);
    return;
  }

  const recoveryTurns: QueuedTurn[] =
    action === "retry"
      ? [paused.failed, ...paused.remaining]
      : paused.remaining;

  // Preserve any new turns enqueued while the queue was paused.
  const newlyQueued = sessionQueues.get(sessionId) ?? [];
  const mergedQueue = [...recoveryTurns, ...newlyQueued];

  pausedQueues.delete(sessionId);

  if (mergedQueue.length === 0) return;

  sessionQueues.set(sessionId, mergedQueue);

  if (!activeTurns.has(sessionId)) {
    drainNextQueued(ctx, sessionId);
  }
  // If a turn is somehow already running, drainNextQueued fires when it finishes.
}

/** Called by DELETE_SESSION to purge all queue state for a deleted session. */
export function cleanupSessionQueueState(sessionId: string): void {
  sessionQueues.delete(sessionId);
  pausedQueues.delete(sessionId);
}
