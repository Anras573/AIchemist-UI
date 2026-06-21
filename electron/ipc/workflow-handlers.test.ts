// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Database from "better-sqlite3";

// Capture every ipcMain.handle registration so we can invoke the wrapped handler
// (which runs the zod validators, exactly as in production).
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => handlers.set(channel, fn),
  },
}));

import { migrate } from "../db";
import { createWorkflow, getWorkflow, listWorkflows, listWorkflowRuns } from "../workflows";
import { registerProvider } from "../agent/runner";
import type { AgentProvider } from "../agent/provider";
import { cleanupSessionQueueState } from "./agent-turn-queue";
import { registerWorkflowHandlers } from "./workflow-handlers";
import * as CH from "../ipc-channels";
import type { IpcEnvelope } from "./errors";

// ─── Fixtures ────────────────────────────────────────────────────────────────

let db: Database.Database;
let projectDir: string;
const runMock = vi.fn<AgentProvider["run"]>();
const mockProvider: AgentProvider = { run: runMock };

/** Invoke a captured handler and return its (already-unwrapped) envelope. */
async function call<T>(channel: string, payload: unknown): Promise<IpcEnvelope<T>> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for ${channel}`);
  return (await fn({} as unknown, payload)) as IpcEnvelope<T>;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  runMock.mockResolvedValue("done");
  registerProvider("ollama", mockProvider);
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-handlers-"));
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "proj-1",
    "Project One",
    projectDir,
    new Date().toISOString()
  );
  registerWorkflowHandlers(db, new Set<string>(), () => null);
});

afterEach(() => {
  db.close();
  fs.rmSync(projectDir, { recursive: true, force: true });
});

// ─── WORKFLOW_UPSERT ─────────────────────────────────────────────────────────────

describe("WORKFLOW_UPSERT", () => {
  it("creates a workflow from a valid payload", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, {
      projectId: "proj-1",
      name: "Nightly",
      prompt: "do work",
      cron: "0 9 * * *",
    });

    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const wf = env.data as { id: string; name: string; cron: string | null };
    expect(wf.name).toBe("Nightly");
    expect(wf.cron).toBe("0 9 * * *");
    expect(getWorkflow(db, wf.id)).not.toBeNull();
  });

  it("patches an existing workflow when an id is supplied", async () => {
    const existing = createWorkflow(db, { projectId: "proj-1", name: "Old", prompt: "p" });

    const env = await call(CH.WORKFLOW_UPSERT, { id: existing.id, name: "New name" });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    expect((env.data as { name: string }).name).toBe("New name");
    expect(getWorkflow(db, existing.id)!.name).toBe("New name");
  });

  it("rejects an unparseable cron expression at upsert", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, {
      projectId: "proj-1",
      name: "Bad cron",
      prompt: "p",
      cron: "definitely not cron",
    });

    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
    // The rejected upsert persisted no workflow row.
    expect(listWorkflows(db, "proj-1")).toHaveLength(0);
  });

  it("rejects a create payload missing required fields", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, { name: "No project or prompt" });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });

  it("rejects whitespace-only name / prompt", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, {
      projectId: "proj-1",
      name: "   ",
      prompt: "real",
    });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });

  it("rejects an unknown provider", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, {
      projectId: "proj-1",
      name: "Bad provider",
      prompt: "p",
      provider: "not-a-provider",
    });
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });

  it("trims and stores normalized name / prompt / cron", async () => {
    const env = await call(CH.WORKFLOW_UPSERT, {
      projectId: "proj-1",
      name: "  Padded  ",
      prompt: "  do work  ",
      cron: "  0 9 * * *  ",
    });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const wf = env.data as { id: string; name: string; prompt: string; cron: string | null };
    expect(wf.name).toBe("Padded");
    expect(wf.prompt).toBe("do work");
    expect(wf.cron).toBe("0 9 * * *");
    const stored = getWorkflow(db, wf.id)!;
    expect(stored.name).toBe("Padded");
    expect(stored.cron).toBe("0 9 * * *");
  });
});

// ─── WORKFLOW_RUN_NOW ────────────────────────────────────────────────────────────

describe("WORKFLOW_RUN_NOW", () => {
  it("creates a run row and drives it to success", async () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Runner",
      prompt: "go",
      provider: "ollama",
    });

    const env = await call(CH.WORKFLOW_RUN_NOW, { workflowId: wf.id });
    expect(env.ok).toBe(true);
    if (!env.ok) return;
    const run = env.data as { id: string; status: string; trigger: string; session_id: string | null };
    expect(run.status).toBe("success");
    expect(run.trigger).toBe("manual");

    const runs = listWorkflowRuns(db, wf.id);
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("success");
    if (run.session_id) cleanupSessionQueueState(run.session_id);
  });

  it("drives the run to error when the turn throws", async () => {
    runMock.mockRejectedValueOnce(new Error("boom"));
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Faulty",
      prompt: "go",
      provider: "ollama",
    });

    const env = await call(CH.WORKFLOW_RUN_NOW, { workflowId: wf.id });
    expect(env.ok).toBe(true); // the handler resolves; the run records the failure
    if (!env.ok) return;
    const run = env.data as { status: string; error: string | null; session_id: string | null };
    expect(run.status).toBe("error");
    expect(run.error).toMatch(/boom/);
    if (run.session_id) cleanupSessionQueueState(run.session_id);
  });

  it("rejects a missing workflowId", async () => {
    const env = await call(CH.WORKFLOW_RUN_NOW, {});
    expect(env.ok).toBe(false);
    if (env.ok) return;
    expect(env.error.code).toBe("invalid_input");
  });
});
