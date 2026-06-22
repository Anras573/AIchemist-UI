import { Cron } from "croner";
import { Notification } from "electron";
import type { Database } from "better-sqlite3";
import type { Workflow, WorkflowRun, WorkflowRunTrigger } from "../../src/types/index";
import * as CH from "../ipc-channels";
import { createSession, updateSessionTitle } from "../sessions";
import {
  createWorkflowRun,
  deleteWorkflow,
  finishWorkflowRun,
  getWorkflow,
  getWorkflowRun,
  listWorkflows,
  setWorkflowReuseSession,
  updateWorkflowLastRun,
} from "../workflows";
import {
  type QueuedTurn,
  type TurnQueueContext,
  isSessionBusy,
  runTurnExclusive,
} from "../ipc/agent-turn-queue";

// Cron validation lives in the dependency-light `../cron` module; re-exported
// here for the scheduler's public surface (and its existing tests).
export { validateCron, isValidCron } from "../cron";

/**
 * Side-effect hooks fired as a run's state changes. The scheduler wires its
 * default implementation (renderer push + OS notification); tests inject their
 * own. Kept optional and fail-safe — a hook that throws never breaks a run.
 */
export interface WorkflowRunHooks {
  /** Called with the run row after each state change (running → terminal). */
  onRunUpdated?: (run: WorkflowRun, workflow: Workflow) => void;
}

// ── Run execution ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Whether a session id still resolves to a row that belongs to `projectId`. A
 * reuse session may have been deleted, or a caller may have pointed
 * `reuse_session_id` at a session in another project (e.g. via WORKFLOW_UPSERT);
 * either way it must not be reused, or the turn would run against the wrong
 * project's path / worktree / config instead of the workflow's `project_id`.
 */
function sessionInProject(db: Database, sessionId: string, projectId: string): boolean {
  const row = db.prepare("SELECT project_id FROM sessions WHERE id = ?").get(sessionId) as
    | { project_id: string }
    | undefined;
  return row?.project_id === projectId;
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
  trigger: WorkflowRunTrigger,
  hooks?: WorkflowRunHooks
): Promise<WorkflowRun> {
  const { db } = ctx;
  const workflow = getWorkflow(db, workflowId);
  if (!workflow) throw new Error(`Workflow not found: ${workflowId}`);

  // Fire the state-change hook fail-safe — a notification / push error must
  // never break (or fail) a run that otherwise completed.
  const emit = (run: WorkflowRun): void => {
    try {
      hooks?.onRunUpdated?.(run, workflow);
    } catch (err) {
      console.error(`[workflow-scheduler] onRunUpdated hook threw for ${workflowId}:`, err);
    }
  };

  // ── Resolve the target session ──────────────────────────────────────────────
  let sessionId: string;
  if (workflow.session_strategy === "reuse") {
    const reuseId = workflow.reuse_session_id;
    if (reuseId && sessionInProject(db, reuseId, workflow.project_id)) {
      sessionId = reuseId;
      // A long-lived reuse session may be mid-turn (a user turn or a prior run).
      // Don't stack — record this fire as skipped.
      if (isSessionBusy(ctx, sessionId)) {
        // A trigger fired and a run row is written, so stamp last_run_at for the
        // skipped outcome too — consistent with the normal path below.
        const skippedRun = createWorkflowRun(db, { workflowId, trigger, sessionId });
        emit(skippedRun); // running — the row is written `running` before skipping
        updateWorkflowLastRun(db, workflowId);
        finishWorkflowRun(db, skippedRun.id, "skipped");
        const finalized = getWorkflowRun(db, skippedRun.id) ?? skippedRun;
        emit(finalized); // skipped
        return finalized;
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
  emit(run); // running

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

  const finalized = getWorkflowRun(db, run.id) ?? run;
  emit(finalized);
  return finalized;
}

// ── Notifications + renderer push ────────────────────────────────────────────────

/**
 * Fire an OS notification summarizing a completed run. Fail-safe and a no-op
 * when notifications are unsupported / unavailable (e.g. headless test env where
 * `electron`'s `Notification` is absent) — a missing notification never breaks a
 * run that otherwise persisted.
 */
function fireRunNotification(run: WorkflowRun, workflow: Workflow): void {
  // Only summarize the meaningful terminal outcomes.
  if (run.status !== "success" && run.status !== "error") return;
  try {
    if (typeof Notification === "undefined" || !Notification.isSupported?.()) return;
    const title = run.status === "success" ? "Workflow completed" : "Workflow failed";
    const body =
      run.status === "success"
        ? workflow.name
        : `${workflow.name}: ${run.error ?? "unknown error"}`;
    new Notification({ title, body }).show();
  } catch (err) {
    console.error(`[workflow-scheduler] notification failed for ${workflow.id}:`, err);
  }
}

/**
 * The scheduler's default run hooks: push `WORKFLOW_RUN_UPDATED` to an open
 * renderer (a no-op when no window is attached) and fire an OS notification on
 * terminal states. Both are fail-safe — see {@link runWorkflow}'s `emit`.
 */
function defaultRunHooks(ctx: TurnQueueContext): WorkflowRunHooks {
  return {
    onRunUpdated: (run, workflow) => {
      ctx.getMainWindow()?.webContents.send(CH.WORKFLOW_RUN_UPDATED, run);
      if (run.status !== "running") fireRunNotification(run, workflow);
    },
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────────

/**
 * Cron scheduler for enabled workflows. Arms one `croner` job per enabled
 * workflow that declares a `cron`, started from `app.whenReady()`.
 *
 * - **Boot:** {@link WorkflowScheduler.start} arms every enabled+cron workflow.
 * - **Edit:** {@link WorkflowScheduler.rearm} stops the old job and re-arms from
 *   the current DB row, so create/update/enable/disable take effect without a
 *   restart. A disabled / cron-cleared workflow ends up with no job.
 * - **Delete:** {@link WorkflowScheduler.cancel} stops a job before its rows go.
 * - **Forward-only:** `croner` fires forward from now; missed occurrences while
 *   the app was closed are not replayed.
 *
 * A run that throws is recorded `error` by {@link runWorkflow}; the job stays
 * armed for the next occurrence (one failure never disarms the workflow).
 */
export class WorkflowScheduler {
  private readonly jobs = new Map<string, Cron>();
  private readonly hooks: WorkflowRunHooks;
  private jobsChangedListener: (() => void) | null = null;

  constructor(
    private readonly ctx: TurnQueueContext,
    hooks?: WorkflowRunHooks
  ) {
    this.hooks = hooks ?? defaultRunHooks(ctx);
  }

  /**
   * Register a single listener fired whenever the set of armed jobs may have
   * changed (boot, re-arm, cancel/delete). Used by the tray to track whether any
   * enabled scheduled workflow exists. Fail-safe — a throwing listener never
   * breaks scheduling.
   */
  onJobsChanged(listener: (() => void) | null): void {
    this.jobsChangedListener = listener;
  }

  private notifyJobsChanged(): void {
    try {
      this.jobsChangedListener?.();
    } catch (err) {
      console.error("[workflow-scheduler] jobs-changed listener threw:", err);
    }
  }

  /**
   * Arm every enabled workflow that declares a cron. Idempotent: re-evaluates
   * from the DB, stopping all previously-armed jobs first so a second call after
   * a workflow was disabled / had its cron cleared leaves it with no job (and no
   * duplicate timers ever survive).
   */
  start(): void {
    this.stopAll();
    for (const wf of listWorkflows(this.ctx.db)) {
      if (wf.enabled && wf.cron) this.arm(wf);
    }
    this.notifyJobsChanged();
  }

  /** Stop a job (if any) and, when the row is still enabled+cron, arm a fresh one. */
  rearm(workflowId: string): void {
    this.cancel(workflowId);
    const wf = getWorkflow(this.ctx.db, workflowId);
    if (wf && wf.enabled && wf.cron) this.arm(wf);
    this.notifyJobsChanged();
  }

  /** Stop and forget a workflow's job. Safe to call when none is armed. */
  cancel(workflowId: string): void {
    const job = this.jobs.get(workflowId);
    if (!job) return;
    job.stop();
    this.jobs.delete(workflowId);
    this.notifyJobsChanged();
  }

  /** Stop all jobs (app shutdown). */
  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
  }

  /** Run a workflow now with the scheduler's notification + push hooks. */
  runNow(workflowId: string, trigger: WorkflowRunTrigger = "manual"): Promise<WorkflowRun> {
    return runWorkflow(this.ctx, workflowId, trigger, this.hooks);
  }

  /** Whether a workflow currently has an armed job. */
  isArmed(workflowId: string): boolean {
    return this.jobs.has(workflowId);
  }

  /** Count of armed jobs (introspection / tests). */
  get armedCount(): number {
    return this.jobs.size;
  }

  /** Delete a workflow's job + rows, cancelling the job first. */
  delete(workflowId: string): void {
    this.cancel(workflowId);
    deleteWorkflow(this.ctx.db, workflowId);
  }

  /** Arm a single workflow. Assumes the row is enabled and has a cron. */
  private arm(wf: Workflow): void {
    if (!wf.cron) return;
    // Stop any job already armed for this id before replacing it, so arm() (and
    // therefore start()) is idempotent and can never leave a duplicate timer
    // firing for the same workflow.
    this.cancel(wf.id);
    try {
      // `new Cron(pattern, fn)` arms immediately and fires forward-only.
      const job = new Cron(wf.cron, () => {
        void this.fire(wf.id);
      });
      this.jobs.set(wf.id, job);
    } catch (err) {
      // A row with an unparseable cron should have been rejected at upsert, but
      // guard so one bad row can't abort arming the rest on boot.
      console.error(`[workflow-scheduler] failed to arm ${wf.id} ("${wf.cron}"):`, err);
    }
  }

  /** Cron tick: run the workflow, swallowing+logging any unexpected throw. */
  private async fire(workflowId: string): Promise<void> {
    try {
      await runWorkflow(this.ctx, workflowId, "cron", this.hooks);
    } catch (err) {
      // runWorkflow only rejects for an unknown id (e.g. deleted mid-tick); the
      // job stays armed for the next occurrence regardless.
      console.error(`[workflow-scheduler] cron run failed for ${workflowId}:`, err);
    }
  }
}
