import type { Database } from "better-sqlite3";
import { Cron } from "croner";
import type { WorkflowRun, WorkflowRunTrigger } from "../../src/types/index";
import { createSession, updateSessionTitle } from "../sessions";
import {
  createWorkflowRun,
  finishWorkflowRun,
  getWorkflow,
  getWorkflowRun,
  setWorkflowReuseSession,
  updateWorkflowLastRun,
} from "../workflows";
import {
  type QueuedTurn,
  type TurnQueueContext,
  isSessionBusy,
  runTurnExclusive,
} from "../ipc/agent-turn-queue";

// ── Cron validation ─────────────────────────────────────────────────────────────
//
// `croner` parses the expression eagerly in its constructor and throws on an
// unparseable pattern. We construct with `{ paused: true }` so validating never
// arms a real timer — we only care whether parsing succeeds.

/**
 * Validate a cron expression via `croner`. Returns the trimmed expression on
 * success; throws an `Error` with a descriptive message on failure. Used at
 * `WORKFLOW_UPSERT` so an unparseable schedule is rejected before it is stored.
 */
export function validateCron(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error("Cron expression is empty");
  try {
    // Constructing parses + validates; paused so no job is armed here.
    new Cron(trimmed, { paused: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression "${expr}": ${detail}`);
  }
  return trimmed;
}

/** Non-throwing companion to {@link validateCron}. */
export function isValidCron(expr: string): boolean {
  try {
    validateCron(expr);
    return true;
  } catch {
    return false;
  }
}

// ── Run execution ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/** Whether a session id still resolves to a row (a reuse session may be deleted). */
function sessionExists(db: Database, sessionId: string): boolean {
  return !!db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sessionId);
}

/**
 * Execute one workflow run end-to-end and record it in `workflow_runs`.
 *
 * Resolves (or creates) the target session per the workflow's `session_strategy`,
 * writes a `running` run row, submits the turn through the shared headless turn
 * entry point, and finalizes the run to `success` / `error` / `skipped` in a
 * `finally`. The turn is dispatched through the same per-session queue machinery
 * as user-driven turns, so a scheduled run never collides with one.
 *
 * Overlap policy: if the (reuse) session is already busy, the fire is recorded as
 * `skipped` rather than stacked. `fresh` workflows get a brand-new session per
 * run, so they never skip.
 *
 * The promise resolves with the finalized run row; it does not reject on a turn
 * error (that is captured as an `error` run). It only rejects if the workflow
 * itself cannot be found.
 */
export async function runWorkflow(
  ctx: TurnQueueContext,
  workflowId: string,
  trigger: WorkflowRunTrigger
): Promise<WorkflowRun> {
  const { db } = ctx;
  const workflow = getWorkflow(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  // ── Resolve the target session ──────────────────────────────────────────────
  let sessionId: string;
  if (workflow.session_strategy === "reuse") {
    const reuseId = workflow.reuse_session_id;
    if (reuseId && sessionExists(db, reuseId)) {
      sessionId = reuseId;
      // A long-lived reuse session may be mid-turn (a user turn or a prior run).
      // Don't stack — record this fire as skipped.
      if (isSessionBusy(ctx, sessionId)) {
        const skippedRun = createWorkflowRun(db, { workflowId, trigger, sessionId });
        finishWorkflowRun(db, skippedRun.id, "skipped");
        return getWorkflowRun(db, skippedRun.id) ?? skippedRun;
      }
    } else {
      // First run (or the stored session was deleted): create + remember it.
      const session = createSession(db, workflow.project_id, workflow.provider, workflow.model);
      sessionId = session.id;
      updateSessionTitle(db, sessionId, `${workflow.name} (workflow)`);
      setWorkflowReuseSession(db, workflowId, sessionId);
    }
  } else {
    // fresh: a clean session per run.
    const session = createSession(db, workflow.project_id, workflow.provider, workflow.model);
    sessionId = session.id;
    updateSessionTitle(db, sessionId, `${workflow.name} — ${nowIso()}`);
  }

  // ── Record + drive the run ────────────────────────────────────────────────────
  const run = createWorkflowRun(db, { workflowId, trigger, sessionId });
  updateWorkflowLastRun(db, workflowId);

  const turn: QueuedTurn = {
    prompt: workflow.prompt,
    agent: workflow.agent ?? undefined,
    oneshotSkills: workflow.skills ?? undefined,
    // "autonomous" runs unattended: ask_user / un-allowlisted approvals resolve
    // immediately instead of hanging. "interactive" leaves the flag falsy so a
    // babysat run can still pause — though a headless run (no window) is forced
    // non-interactive downstream regardless (see executeAgentTurn).
    nonInteractive: workflow.autonomy === "autonomous",
  };

  try {
    const { skipped } = await runTurnExclusive(ctx, sessionId, turn);
    finishWorkflowRun(db, run.id, skipped ? "skipped" : "success");
  } catch (err) {
    finishWorkflowRun(db, run.id, "error", err instanceof Error ? err.message : String(err));
  }

  return getWorkflowRun(db, run.id) ?? run;
}
