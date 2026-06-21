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
} from "../workflows";
import { registerProvider } from "./runner";
import type { AgentProvider } from "./provider";
import { cleanupSessionQueueState, type TurnQueueContext } from "../ipc/agent-turn-queue";
import { isValidCron, runWorkflow, validateCron } from "./workflow-scheduler";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: Database.Database;
let projectDir: string;
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
  db = makeDb(projectDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
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

    cleanupSessionQueueState(session.id);
  });

  it("throws for an unknown workflow id", async () => {
    await expect(runWorkflow(makeCtx(), "nope", "manual")).rejects.toThrow(/not found/i);
  });
});
