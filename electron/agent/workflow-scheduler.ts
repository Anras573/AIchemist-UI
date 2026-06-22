import * as fs from "fs";
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
 * Coalescing window for file-watch triggers. A single save (or a `git checkout`,
 * a build, an editor's atomic-rename write) emits a burst of `fs.watch` events;
 * we wait for the burst to settle before firing exactly one run. Overridable per
 * scheduler instance (tests use a short window).
 */
export const FILE_WATCH_DEBOUNCE_MS = 500;

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

/** A live file watcher plus its pending debounce timer (if any). */
interface FileWatchHandle {
  watcher: fs.FSWatcher;
  debounce: ReturnType<typeof setTimeout> | null;
}

/**
 * Trigger manager for enabled workflows. Arms two kinds of trigger, started from
 * `app.whenReady()`:
 *
 * - **cron** — one `croner` job per enabled workflow that declares a `cron`.
 * - **file** — one `fs.watch` watcher per enabled workflow that declares a
 *   `watch_path`; a change under the path fires a (debounced) run.
 *
 * A workflow may declare a cron, a watch_path, both, or neither (manual-only).
 *
 * - **Boot:** {@link WorkflowScheduler.start} arms every enabled workflow that
 *   has at least one trigger.
 * - **Edit:** {@link WorkflowScheduler.rearm} stops the old triggers and re-arms
 *   from the current DB row, so create/update/enable/disable take effect without
 *   a restart. A disabled / trigger-cleared workflow ends up with no triggers.
 * - **Delete:** {@link WorkflowScheduler.cancel} stops a workflow's triggers
 *   before its rows go.
 * - **Forward-only:** `croner` fires forward from now and file events only fire
 *   for changes made while watching; neither replays anything missed while the
 *   app was closed.
 *
 * A run that throws is recorded `error` by {@link runWorkflow}; the triggers stay
 * armed for the next occurrence (one failure never disarms the workflow).
 *
 * `armedCount` / `isArmed` count a workflow once if it has *any* armed trigger,
 * so the tray + survive-window-close behavior covers file-watch workflows too.
 */
export class WorkflowScheduler {
  private readonly jobs = new Map<string, Cron>();
  private readonly fileWatchers = new Map<string, FileWatchHandle>();
  private readonly hooks: WorkflowRunHooks;
  private readonly fileWatchDebounceMs: number;
  private jobsChangedListener: (() => void) | null = null;

  constructor(
    private readonly ctx: TurnQueueContext,
    hooks?: WorkflowRunHooks,
    options?: { fileWatchDebounceMs?: number }
  ) {
    this.hooks = hooks ?? defaultRunHooks(ctx);
    this.fileWatchDebounceMs = options?.fileWatchDebounceMs ?? FILE_WATCH_DEBOUNCE_MS;
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
   * Arm every enabled workflow that declares at least one trigger (a `cron` or a
   * `watch_path`). Idempotent: re-evaluates from the DB, stopping all
   * previously-armed triggers first so a second call after a workflow was
   * disabled / had its triggers cleared leaves it unarmed (and no duplicate
   * timers / watchers ever survive).
   */
  start(): void {
    this.stopAll();
    for (const wf of listWorkflows(this.ctx.db)) {
      if (wf.enabled && hasTrigger(wf)) this.arm(wf);
    }
    // One notification after the full armed set is stable — never per-arm.
    this.notifyJobsChanged();
  }

  /** Stop a workflow's triggers and, when it is still enabled+triggered, re-arm them. */
  rearm(workflowId: string): void {
    // Use the silent low-level stop here; `rearm` emits a single notification
    // after the final armed set is settled, so the tray sees one stable count
    // change rather than a transient drop-then-restore (which could flicker it).
    this.stopJob(workflowId);
    const wf = getWorkflow(this.ctx.db, workflowId);
    if (wf && wf.enabled && hasTrigger(wf)) this.arm(wf);
    this.notifyJobsChanged();
  }

  /** Stop and forget a workflow's job. Safe to call when none is armed. */
  cancel(workflowId: string): void {
    if (this.stopJob(workflowId)) this.notifyJobsChanged();
  }

  /**
   * Low-level: stop and forget *all* of a workflow's triggers (cron job + file
   * watcher), returning whether any existed. Does NOT notify — callers emit a
   * single jobs-changed notification once the armed set is stable, so high-level
   * ops never fire the listener twice.
   */
  private stopJob(workflowId: string): boolean {
    let existed = false;
    const job = this.jobs.get(workflowId);
    if (job) {
      job.stop();
      this.jobs.delete(workflowId);
      existed = true;
    }
    if (this.stopFileWatcher(workflowId)) existed = true;
    return existed;
  }

  /** Stop and forget a workflow's file watcher (clearing any pending debounce). */
  private stopFileWatcher(workflowId: string): boolean {
    const handle = this.fileWatchers.get(workflowId);
    if (!handle) return false;
    if (handle.debounce) clearTimeout(handle.debounce);
    try {
      handle.watcher.close();
    } catch {
      // Closing an already-errored watcher can throw; the watcher is being
      // forgotten regardless, so swallow.
    }
    this.fileWatchers.delete(workflowId);
    return true;
  }

  /** Stop all triggers (app shutdown). */
  stopAll(): void {
    for (const job of this.jobs.values()) job.stop();
    this.jobs.clear();
    for (const workflowId of [...this.fileWatchers.keys()]) this.stopFileWatcher(workflowId);
  }

  /** Run a workflow now with the scheduler's notification + push hooks. */
  runNow(workflowId: string, trigger: WorkflowRunTrigger = "manual"): Promise<WorkflowRun> {
    return runWorkflow(this.ctx, workflowId, trigger, this.hooks);
  }

  /** Whether a workflow currently has any armed trigger (cron or file watcher). */
  isArmed(workflowId: string): boolean {
    return this.jobs.has(workflowId) || this.fileWatchers.has(workflowId);
  }

  /**
   * Count of workflows with at least one armed trigger (introspection / tests).
   * A workflow armed with both a cron and a file watcher counts once, so this is
   * the live number of enabled scheduled workflows the tray gates on.
   */
  get armedCount(): number {
    let count = this.jobs.size;
    for (const id of this.fileWatchers.keys()) {
      if (!this.jobs.has(id)) count++;
    }
    return count;
  }

  /** Delete a workflow's job + rows, cancelling the job first. */
  delete(workflowId: string): void {
    this.cancel(workflowId);
    deleteWorkflow(this.ctx.db, workflowId);
  }

  /**
   * Arm a single workflow's triggers. Assumes the row is enabled and has at
   * least one trigger; arms whichever of cron / file-watch it declares.
   */
  private arm(wf: Workflow): void {
    // Stop anything already armed for this id before replacing it, so arm() (and
    // therefore start()) is idempotent and can never leave a duplicate timer /
    // watcher firing for the same workflow. Silent stop — the caller (start/
    // rearm) owns the single jobs-changed notification.
    this.stopJob(wf.id);
    if (wf.cron) this.armCron(wf);
    if (wf.watch_path) this.armFileWatch(wf);
  }

  /** Arm the cron job for a workflow (assumes `wf.cron` is set). */
  private armCron(wf: Workflow): void {
    try {
      // `new Cron(pattern, fn)` arms immediately and fires forward-only.
      const job = new Cron(wf.cron!, () => {
        void this.fire(wf.id, "cron");
      });
      this.jobs.set(wf.id, job);
    } catch (err) {
      // A row with an unparseable cron should have been rejected at upsert, but
      // guard so one bad row can't abort arming the rest on boot.
      console.error(`[workflow-scheduler] failed to arm cron for ${wf.id} ("${wf.cron}"):`, err);
    }
  }

  /**
   * Arm the file watcher for a workflow (assumes `wf.watch_path` is set). A
   * change under the path schedules a debounced run. Fail-safe: an unwatchable
   * path (missing, permission denied, recursive-watch unsupported) is logged and
   * skipped, never aborting the arming of the rest.
   */
  private armFileWatch(wf: Workflow): void {
    const watchPath = wf.watch_path!;
    try {
      // `recursive: true` covers a watched directory tree (supported on macOS,
      // Windows, and modern Linux). On a single file it is harmless.
      const watcher = fs.watch(watchPath, { recursive: true }, () => {
        this.scheduleFileFire(wf.id);
      });
      // A delayed I/O error (the path is removed while watching) must not crash
      // the process — drop the watcher and log. Dropping it lowers armedCount, so
      // notify the jobs-changed listener (the tray) here: unlike start/rearm/
      // cancel, nothing else will fire it for an async error, and the tray would
      // otherwise stay out of sync until the next explicit op.
      watcher.on("error", (err) => {
        console.error(`[workflow-scheduler] file watcher error for ${wf.id} ("${watchPath}"):`, err);
        if (this.stopFileWatcher(wf.id)) this.notifyJobsChanged();
      });
      this.fileWatchers.set(wf.id, { watcher, debounce: null });
    } catch (err) {
      console.error(
        `[workflow-scheduler] failed to watch "${watchPath}" for ${wf.id}:`,
        err
      );
    }
  }

  /**
   * Coalesce a burst of file events into a single run: reset the per-workflow
   * debounce timer on each event and fire only once it settles.
   */
  private scheduleFileFire(workflowId: string): void {
    const handle = this.fileWatchers.get(workflowId);
    if (!handle) return; // watcher was stopped between event and dispatch
    if (handle.debounce) clearTimeout(handle.debounce);
    handle.debounce = setTimeout(() => {
      handle.debounce = null;
      void this.fire(workflowId, "file");
    }, this.fileWatchDebounceMs);
  }

  /**
   * Trigger tick (cron or file): run the workflow, swallowing+logging any
   * unexpected throw so the triggers stay armed for the next occurrence.
   */
  private async fire(workflowId: string, trigger: WorkflowRunTrigger): Promise<void> {
    try {
      await runWorkflow(this.ctx, workflowId, trigger, this.hooks);
    } catch (err) {
      // runWorkflow only rejects for an unknown id (e.g. deleted mid-tick); the
      // triggers stay armed for the next occurrence regardless.
      console.error(`[workflow-scheduler] ${trigger} run failed for ${workflowId}:`, err);
    }
  }
}

/** Whether a workflow declares at least one automatic trigger (cron or file). */
function hasTrigger(wf: Workflow): boolean {
  return Boolean(wf.cron || wf.watch_path);
}
