// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

import { migrate } from "../db";
import { createSession, getSession } from "../sessions";
import {
  createWorkflow,
  getWorkflow,
  listWorkflowRuns,
  updateWorkflow,
} from "../workflows";
import { registerProvider } from "./runner";
import type { AgentProvider } from "./provider";
import { cleanupSessionQueueState, type TurnQueueContext } from "../ipc/agent-turn-queue";
import {
  isValidCron,
  runWorkflow,
  validateCron,
  WorkflowScheduler,
  type WorkflowRunHooks,
} from "./workflow-scheduler";
import { _setCodexForTests } from "./codex";
import { _setNativeTracesRootForTests } from "../native-transcript";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: Database.Database;
let projectDir: string;
// Extra temp project dirs created by individual tests, cleaned up in afterEach.
let extraDirs: string[];
const runMock = vi.fn<AgentProvider["run"]>();

/** A mock provider registered under the "ollama" id so runs are type-safe. */
const mockProvider: AgentProvider = { run: runMock };

function makeDb(projectPath: string): Database.Database {
  const database = new Database(":memory:");
  migrate(database);
  database
    .prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)")
    .run("proj-1", "Project One", projectPath, new Date().toISOString());
  return database;
}

function makeCtx(): TurnQueueContext {
  return { db, activeTurns: new Set<string>(), getMainWindow: () => null };
}

beforeEach(() => {
  vi.clearAllMocks();
  runMock.mockResolvedValue("workflow output");
  registerProvider("ollama", mockProvider);
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sched-"));
  extraDirs = [];
  db = makeDb(projectDir);
});

afterEach(() => {
  // Reset the Codex provider's injected SDK + redirected trace root (set by the
  // Codex workflow integration test) so they never leak into other tests.
  _setCodexForTests(null);
  _setNativeTracesRootForTests(null);
  db.close();
  for (const dir of [projectDir, ...extraDirs]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── validateCron ──────────────────────────────────────────────────────────────

describe("validateCron", () => {
  it("returns the trimmed expression for a valid cron", () => {
    expect(validateCron("  0 9 * * * ")).toBe("0 9 * * *");
    expect(isValidCron("*/5 * * * *")).toBe(true);
  });

  it("throws / reports false for an unparseable expression", () => {
    expect(() => validateCron("not a cron")).toThrow(/Invalid cron expression/);
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
  });
});

// ─── runWorkflow — end to end ────────────────────────────────────────────────────

describe("runWorkflow", () => {
  it("executes a fresh workflow end-to-end via the headless entry point", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Nightly triage",
      prompt: "Triage new issues",
      provider: "ollama",
      model: "llama",
    });

    const run = await runWorkflow(makeCtx(), wf.id, "manual");

    expect(run.status).toBe("success");
    expect(run.trigger).toBe("manual");
    expect(run.ended_at).not.toBeNull();
    expect(run.session_id).toBeTruthy();

    // The provider ran with the workflow's prompt in a freshly created session.
    expect(runMock).toHaveBeenCalledTimes(1);
    const params = runMock.mock.calls[0][0];
    expect(params.prompt).toBe("Triage new issues");
    expect(params.sessionId).toBe(run.session_id);
    // Interactive autonomy + no window → forced non-interactive downstream.
    expect(params.nonInteractive).toBe(true);

    // A fresh session was created for the run and the run was recorded.
    expect(getSession(db, run.session_id!).id).toBe(run.session_id);
    expect(listWorkflowRuns(db, wf.id)).toHaveLength(1);
    // last_run_at stamped.
    expect(getWorkflow(db, wf.id)!.last_run_at).not.toBeNull();

    cleanupSessionQueueState(run.session_id!);
  });

  it("passes nonInteractive=true for an autonomous workflow", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Auto fixer",
      prompt: "Fix the build",
      provider: "ollama",
      autonomy: "autonomous",
    });

    const run = await runWorkflow(makeCtx(), wf.id, "manual");
    expect(run.status).toBe("success");
    expect(runMock.mock.calls[0][0].nonInteractive).toBe(true);

    cleanupSessionQueueState(run.session_id!);
  });

  it("runs an autonomous Codex workflow end-to-end with a workspace-write / never-approve thread", async () => {
    // The real Codex provider is registered by default; inject a mock SDK (so no
    // codex binary is spawned) and redirect its trace transcript. This exercises
    // the full chain: autonomous workflow → nonInteractive → codex.run →
    // resolveSandboxPolicy → thread options.
    const tracesDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-codex-traces-"));
    extraDirs.push(tracesDir);
    _setNativeTracesRootForTests(tracesDir);

    const startThread = vi.fn(() => ({
      get id() {
        return "thread-codex";
      },
      runStreamed: vi.fn(async () => ({
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread-codex" };
          yield { type: "item.completed", item: { id: "m1", type: "agent_message", text: "fixed the build" } };
          yield {
            type: "turn.completed",
            usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 0 },
          };
        })(),
      })),
    }));
    _setCodexForTests({ startThread, resumeThread: vi.fn() } as unknown as Parameters<typeof _setCodexForTests>[0]);

    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Codex auto fixer",
      prompt: "Fix the build",
      provider: "codex",
      autonomy: "autonomous",
    });

    // Use a NON-null stub window so `nonInteractive` is driven by the workflow's
    // autonomy (turn.nonInteractive), not the headless `win === null` fallback in
    // executeAgentTurn. With a null window the turn is forced non-interactive
    // regardless of autonomy, so the assertion below would pass even if autonomy
    // were ignored; a real window makes the test actually discriminate.
    const stubWindow = { webContents: { send: vi.fn() } } as unknown as NonNullable<
      ReturnType<TurnQueueContext["getMainWindow"]>
    >;
    const ctx: TurnQueueContext = { db, activeTurns: new Set<string>(), getMainWindow: () => stubWindow };
    const run = await runWorkflow(ctx, wf.id, "manual");

    expect(run.status).toBe("success");
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
        workingDirectory: projectDir,
      }),
    );

    cleanupSessionQueueState(run.session_id!);
  });

  it("records an error run when the turn throws", async () => {
    runMock.mockRejectedValueOnce(new Error("provider exploded"));
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Flaky",
      prompt: "do the thing",
      provider: "ollama",
    });

    const run = await runWorkflow(makeCtx(), wf.id, "cron");

    expect(run.status).toBe("error");
    expect(run.error).toMatch(/provider exploded/);
    expect(run.ended_at).not.toBeNull();

    cleanupSessionQueueState(run.session_id!);
  });

  it("reuses one session across runs for the 'reuse' strategy", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Long-lived",
      prompt: "accumulate context",
      provider: "ollama",
      sessionStrategy: "reuse",
    });

    const first = await runWorkflow(makeCtx(), wf.id, "manual");
    const second = await runWorkflow(makeCtx(), wf.id, "manual");

    expect(first.session_id).toBe(second.session_id);
    expect(getWorkflow(db, wf.id)!.reuse_session_id).toBe(first.session_id);
    expect(runMock).toHaveBeenCalledTimes(2);

    cleanupSessionQueueState(first.session_id!);
  });

  it("records a 'skipped' run when the reuse session is busy (overlap policy)", async () => {
    // Pre-create the reuse session and mark it busy so the fire overlaps.
    const session = createSession(db, "proj-1", "ollama", "llama");
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Overlapping",
      prompt: "work",
      provider: "ollama",
      sessionStrategy: "reuse",
      reuseSessionId: session.id,
    });

    const ctx = makeCtx();
    ctx.activeTurns.add(session.id); // a turn is already in flight on this session

    const run = await runWorkflow(ctx, wf.id, "cron");

    expect(run.status).toBe("skipped");
    expect(run.session_id).toBe(session.id);
    // The overlapping fire never invoked the provider.
    expect(runMock).not.toHaveBeenCalled();
    expect(listWorkflowRuns(db, wf.id)).toHaveLength(1);
    // A trigger fired + a run row was written, so last_run_at is stamped too.
    expect(getWorkflow(db, wf.id)!.last_run_at).not.toBeNull();

    cleanupSessionQueueState(session.id);
  });

  it("does not reuse a session from another project (creates a fresh one in-project)", async () => {
    // A reuse_session_id pointing at a different project's session must not be
    // honored — the run would otherwise execute against the wrong project.
    const projectDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "wf-sched-p2-"));
    extraDirs.push(projectDir2);
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
      "proj-2",
      "Project Two",
      projectDir2,
      new Date().toISOString()
    );
    const foreign = createSession(db, "proj-2", "ollama", "llama");
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Cross-project",
      prompt: "work",
      provider: "ollama",
      sessionStrategy: "reuse",
      reuseSessionId: foreign.id,
    });

    const run = await runWorkflow(makeCtx(), wf.id, "manual");

    expect(run.status).toBe("success");
    expect(run.session_id).not.toBe(foreign.id);
    // A new in-project reuse session was created and persisted.
    expect(getSession(db, run.session_id!).project_id).toBe("proj-1");
    expect(getWorkflow(db, wf.id)!.reuse_session_id).toBe(run.session_id);

    cleanupSessionQueueState(run.session_id!);
  });

  it("throws for an unknown workflow id", async () => {
    await expect(runWorkflow(makeCtx(), "nope", "manual")).rejects.toThrow(/not found/i);
  });

  it("fires the onRunUpdated hook on running and terminal state", async () => {
    const updates: Array<{ status: string }> = [];
    const hooks: WorkflowRunHooks = {
      onRunUpdated: (run) => updates.push({ status: run.status }),
    };
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Hooked",
      prompt: "go",
      provider: "ollama",
    });

    const run = await runWorkflow(makeCtx(), wf.id, "manual", hooks);

    expect(updates.map((u) => u.status)).toEqual(["running", "success"]);
    cleanupSessionQueueState(run.session_id!);
  });

  it("fires the onRunUpdated hook on running then skipped for an overlapping run", async () => {
    const session = createSession(db, "proj-1", "ollama", "llama");
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Overlap hooks",
      prompt: "work",
      provider: "ollama",
      sessionStrategy: "reuse",
      reuseSessionId: session.id,
    });
    const ctx = makeCtx();
    ctx.activeTurns.add(session.id); // session busy → the fire is skipped

    const updates: string[] = [];
    const hooks: WorkflowRunHooks = { onRunUpdated: (run) => updates.push(run.status) };

    const run = await runWorkflow(ctx, wf.id, "cron", hooks);

    expect(run.status).toBe("skipped");
    // The skipped path still goes through running → terminal, per the contract.
    expect(updates).toEqual(["running", "skipped"]);
    expect(runMock).not.toHaveBeenCalled();

    cleanupSessionQueueState(session.id);
  });

  it("does not let a throwing onRunUpdated hook fail the run", async () => {
    const hooks: WorkflowRunHooks = {
      onRunUpdated: () => {
        throw new Error("hook boom");
      },
    };
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Hook thrower",
      prompt: "go",
      provider: "ollama",
    });

    const run = await runWorkflow(makeCtx(), wf.id, "manual", hooks);
    expect(run.status).toBe("success");
    cleanupSessionQueueState(run.session_id!);
  });
});

// ─── WorkflowScheduler — arming lifecycle ────────────────────────────────────────

describe("WorkflowScheduler", () => {
  // A silent hook keeps the default OS-notification path out of these tests.
  const silentHooks: WorkflowRunHooks = { onRunUpdated: () => {} };

  function makeScheduler(): WorkflowScheduler {
    return new WorkflowScheduler(makeCtx(), silentHooks);
  }

  it("arms only enabled workflows that declare a cron on start()", () => {
    const armed = createWorkflow(db, {
      projectId: "proj-1",
      name: "Armed",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: true,
    });
    const disabled = createWorkflow(db, {
      projectId: "proj-1",
      name: "Disabled",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: false,
    });
    const noCron = createWorkflow(db, {
      projectId: "proj-1",
      name: "Manual only",
      prompt: "p",
    });

    const scheduler = makeScheduler();
    scheduler.start();

    expect(scheduler.isArmed(armed.id)).toBe(true);
    expect(scheduler.isArmed(disabled.id)).toBe(false);
    expect(scheduler.isArmed(noCron.id)).toBe(false);
    expect(scheduler.armedCount).toBe(1);

    scheduler.stopAll();
    expect(scheduler.armedCount).toBe(0);
  });

  it("start() is idempotent — a second call disarms now-disabled workflows", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Re-evaluated",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(true);
    expect(scheduler.armedCount).toBe(1);

    // Disable the workflow in the DB, then re-run start(): the previously-armed
    // job must be stopped (no leftover timer), and no duplicate is created.
    updateWorkflow(db, wf.id, { enabled: false });
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(false);
    expect(scheduler.armedCount).toBe(0);

    scheduler.stopAll();
  });

  it("re-arms on enable and disarms on disable / cron-clear", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Toggler",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: false,
    });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(false); // disabled at boot

    // Enable → armed.
    updateWorkflow(db, wf.id, { enabled: true });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(true);

    // Disable → disarmed.
    updateWorkflow(db, wf.id, { enabled: false });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);

    // Enable again then clear the cron → disarmed (manual-only).
    updateWorkflow(db, wf.id, { enabled: true });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(true);
    updateWorkflow(db, wf.id, { cron: null });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);

    scheduler.stopAll();
  });

  it("re-arms (replaces the job) when the cron changes", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Reschedule",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(scheduler.armedCount).toBe(1);

    updateWorkflow(db, wf.id, { cron: "0 18 * * *" });
    scheduler.rearm(wf.id);
    // Still exactly one armed job — re-armed, not duplicated.
    expect(scheduler.isArmed(wf.id)).toBe(true);
    expect(scheduler.armedCount).toBe(1);

    scheduler.stopAll();
  });

  it("cancels the job and removes rows on delete()", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Doomed",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(true);

    scheduler.delete(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);
    expect(getWorkflow(db, wf.id)).toBeNull();

    scheduler.stopAll();
  });

  it("notifies the jobs-changed listener on start / rearm / delete", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Watched",
      prompt: "p",
      cron: "0 9 * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    const onChanged = vi.fn();
    scheduler.onJobsChanged(onChanged);

    // start() reconciles all jobs and fires exactly once (never per-arm).
    scheduler.start();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The listener observes the current armed count, gating the tray.
    expect(scheduler.armedCount).toBe(1);

    // Re-arming a previously-armed job must fire exactly once — not twice (a
    // transient drop-then-restore would flicker the tray).
    onChanged.mockClear();
    scheduler.rearm(wf.id);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(scheduler.armedCount).toBe(1);

    // Disabling + re-arming drops the job and still fires exactly once.
    onChanged.mockClear();
    updateWorkflow(db, wf.id, { enabled: false });
    scheduler.rearm(wf.id);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(scheduler.armedCount).toBe(0);

    // delete() cancels the (re-armed) job and must notify exactly once so the
    // tray drops the workflow from its count.
    onChanged.mockClear();
    updateWorkflow(db, wf.id, { enabled: true });
    scheduler.rearm(wf.id);
    expect(scheduler.armedCount).toBe(1);
    onChanged.mockClear();
    scheduler.delete(wf.id);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(scheduler.armedCount).toBe(0);
    expect(getWorkflow(db, wf.id)).toBeNull();

    // A throwing listener never breaks scheduling.
    scheduler.onJobsChanged(() => {
      throw new Error("boom");
    });
    expect(() => scheduler.rearm(wf.id)).not.toThrow();

    // A null listener detaches cleanly.
    scheduler.onJobsChanged(null);
    expect(() => scheduler.start()).not.toThrow();

    scheduler.stopAll();
  });

  it("keeps the job armed after a failing run", async () => {
    runMock.mockRejectedValueOnce(new Error("provider exploded"));
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Flaky armed",
      prompt: "p",
      provider: "ollama",
      cron: "0 9 * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(true);

    // A failing run never disarms the workflow — one failure doesn't disable it.
    const run = await runWorkflow(makeCtx(), wf.id, "cron", silentHooks);
    expect(run.status).toBe("error");
    expect(scheduler.isArmed(wf.id)).toBe(true);

    scheduler.stopAll();
    cleanupSessionQueueState(run.session_id!);
  });

  it("runs to success with default hooks and no window (notification absent is non-fatal)", async () => {
    // No injected hooks → exercises defaultRunHooks + the fireRunNotification
    // guard. getMainWindow returns null, so nothing is pushed and no Notification
    // is available — the run must still persist a success.
    const scheduler = new WorkflowScheduler(makeCtx());
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "No window",
      prompt: "p",
      provider: "ollama",
    });

    const run = await scheduler.runNow(wf.id);
    expect(run.status).toBe("success");
    expect(listWorkflowRuns(db, wf.id)).toHaveLength(1);

    scheduler.stopAll();
    cleanupSessionQueueState(run.session_id!);
  });

  it("fires an armed cron workflow on schedule and records run history", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Per-second",
      prompt: "tick",
      provider: "ollama",
      // 6-field cron with seconds → fires every second.
      cron: "* * * * * *",
      enabled: true,
    });
    const scheduler = makeScheduler();
    scheduler.start();

    await vi.waitFor(
      () => {
        expect(listWorkflowRuns(db, wf.id).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 3000, interval: 50 }
    );

    scheduler.stopAll();

    const runs = listWorkflowRuns(db, wf.id);
    expect(runs[0].status).toBe("success");
    expect(runs[0].trigger).toBe("cron");
    for (const run of runs) {
      if (run.session_id) cleanupSessionQueueState(run.session_id);
    }
  });
});

// ─── WorkflowScheduler — file-watch triggers ─────────────────────────────────────

describe("WorkflowScheduler — file-watch triggers", () => {
  const silentHooks: WorkflowRunHooks = { onRunUpdated: () => {} };

  // A short debounce keeps the fire-on-change test fast without flaking.
  function makeWatchScheduler(): WorkflowScheduler {
    return new WorkflowScheduler(makeCtx(), silentHooks, { fileWatchDebounceMs: 20 });
  }

  it("arms a file watcher for an enabled workflow with a watch_path", () => {
    const watched = createWorkflow(db, {
      projectId: "proj-1",
      name: "Watcher",
      prompt: "p",
      watchPath: projectDir,
      enabled: true,
    });
    const disabled = createWorkflow(db, {
      projectId: "proj-1",
      name: "Disabled watcher",
      prompt: "p",
      watchPath: projectDir,
      enabled: false,
    });

    const scheduler = makeWatchScheduler();
    scheduler.start();

    expect(scheduler.isArmed(watched.id)).toBe(true);
    expect(scheduler.isArmed(disabled.id)).toBe(false);
    expect(scheduler.armedCount).toBe(1);

    scheduler.stopAll();
    expect(scheduler.armedCount).toBe(0);
  });

  it("counts a workflow with both a cron and a watch_path only once", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Both triggers",
      prompt: "p",
      cron: "0 9 * * *",
      watchPath: projectDir,
      enabled: true,
    });

    const scheduler = makeWatchScheduler();
    scheduler.start();

    expect(scheduler.isArmed(wf.id)).toBe(true);
    expect(scheduler.armedCount).toBe(1);

    scheduler.stopAll();
  });

  it("is fail-safe when the watch_path cannot be watched (missing path)", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Bad path",
      prompt: "p",
      watchPath: path.join(projectDir, "does-not-exist"),
      enabled: true,
    });

    const scheduler = makeWatchScheduler();
    // Arming an unwatchable path must not throw, and must leave it unarmed.
    expect(() => scheduler.start()).not.toThrow();
    expect(scheduler.isArmed(wf.id)).toBe(false);
    expect(scheduler.armedCount).toBe(0);

    scheduler.stopAll();
  });

  it("disarms the watcher on rearm (disabled) and on delete", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Toggle watcher",
      prompt: "p",
      watchPath: projectDir,
      enabled: true,
    });
    const scheduler = makeWatchScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(true);

    updateWorkflow(db, wf.id, { enabled: false });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);

    // Re-enable, then delete → watcher gone and row removed.
    updateWorkflow(db, wf.id, { enabled: true });
    scheduler.rearm(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(true);
    scheduler.delete(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);
    expect(getWorkflow(db, wf.id)).toBeNull();

    scheduler.stopAll();
  });

  it("fires a debounced 'file' run when a file under the watched path changes", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "On change",
      prompt: "react to change",
      provider: "ollama",
      watchPath: projectDir,
      enabled: true,
    });
    const scheduler = makeWatchScheduler();
    scheduler.start();
    expect(scheduler.isArmed(wf.id)).toBe(true);

    // Touch a file under the watched directory to trigger the watcher.
    fs.writeFileSync(path.join(projectDir, "trigger.txt"), "change");

    await vi.waitFor(
      () => {
        expect(listWorkflowRuns(db, wf.id).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 4000, interval: 50 }
    );

    // Stop watching before asserting so no further fires race the teardown.
    scheduler.stopAll();

    const runs = listWorkflowRuns(db, wf.id);
    expect(runs[0].trigger).toBe("file");
    expect(runs[0].status).toBe("success");
    expect(runMock).toHaveBeenCalled();
    expect(runMock.mock.calls[0][0].prompt).toBe("react to change");

    for (const run of runs) {
      if (run.session_id) cleanupSessionQueueState(run.session_id);
    }
  });

  it("does not fire after the watcher is cancelled", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Cancelled",
      prompt: "p",
      provider: "ollama",
      watchPath: projectDir,
      enabled: true,
    });
    const scheduler = makeWatchScheduler();
    scheduler.start();
    scheduler.cancel(wf.id);
    expect(scheduler.isArmed(wf.id)).toBe(false);

    fs.writeFileSync(path.join(projectDir, "after-cancel.txt"), "change");
    // Give a cancelled watcher a chance to (wrongly) fire.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(listWorkflowRuns(db, wf.id)).toHaveLength(0);
    expect(runMock).not.toHaveBeenCalled();

    scheduler.stopAll();
  });
});
