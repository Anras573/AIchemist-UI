// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "./db";
import {
  createWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  setWorkflowEnabled,
  setWorkflowReuseSession,
  updateWorkflowLastRun,
  deleteWorkflow,
  createWorkflowRun,
  finishWorkflowRun,
  setWorkflowRunSession,
  listWorkflowRuns,
} from "./workflows";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
    "proj-1",
    "Project One",
    "/tmp/proj-1",
    new Date().toISOString()
  );
  return db;
}

let db: Database.Database;
beforeEach(() => {
  db = makeDb();
});

// ─── createWorkflow / getWorkflow ──────────────────────────────────────────────

describe("createWorkflow", () => {
  it("round-trips through getWorkflow with defaults", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Nightly triage",
      prompt: "Triage new bug issues",
    });

    expect(wf.enabled).toBe(true);
    expect(wf.session_strategy).toBe("fresh");
    expect(wf.autonomy).toBe("interactive");
    expect(wf.last_run_at).toBeNull();

    const fetched = getWorkflow(db, wf.id);
    expect(fetched).toEqual(wf);
  });

  it("persists all optional fields including skills JSON", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "Build doctor",
      prompt: "Fix the build",
      provider: "anthropic",
      model: "claude-opus-4-8",
      agent: "fixer",
      skills: ["code-review", "verify"],
      cron: "0 9 * * *",
      watchPath: "/tmp/proj-1/src",
      enabled: false,
      sessionStrategy: "reuse",
      reuseSessionId: "sess-9",
      autonomy: "autonomous",
    });

    const fetched = getWorkflow(db, wf.id)!;
    expect(fetched.provider).toBe("anthropic");
    expect(fetched.model).toBe("claude-opus-4-8");
    expect(fetched.agent).toBe("fixer");
    expect(fetched.skills).toEqual(["code-review", "verify"]);
    expect(fetched.cron).toBe("0 9 * * *");
    expect(fetched.watch_path).toBe("/tmp/proj-1/src");
    expect(fetched.enabled).toBe(false);
    expect(fetched.session_strategy).toBe("reuse");
    expect(fetched.reuse_session_id).toBe("sess-9");
    expect(fetched.autonomy).toBe("autonomous");
  });

  it("defaults watch_path to null and round-trips an update", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "w", prompt: "p" });
    expect(wf.watch_path).toBeNull();
    expect(getWorkflow(db, wf.id)!.watch_path).toBeNull();

    const updated = updateWorkflow(db, wf.id, { watch_path: "/tmp/proj-1/watched" })!;
    expect(updated.watch_path).toBe("/tmp/proj-1/watched");
    expect(getWorkflow(db, wf.id)!.watch_path).toBe("/tmp/proj-1/watched");

    // An explicit null clears it again.
    expect(updateWorkflow(db, wf.id, { watch_path: null })!.watch_path).toBeNull();
    expect(getWorkflow(db, wf.id)!.watch_path).toBeNull();
  });

  it("normalizes empty skills to null", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "y", skills: [] });
    expect(getWorkflow(db, wf.id)!.skills).toBeNull();
  });

  it("drops reuse_session_id on a non-reuse (fresh) workflow", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "x",
      prompt: "y",
      sessionStrategy: "fresh",
      reuseSessionId: "sess-stale",
    });
    expect(wf.reuse_session_id).toBeNull();
    expect(getWorkflow(db, wf.id)!.reuse_session_id).toBeNull();
  });

  it("rejects a workflow for a non-existent project (FK enforced)", () => {
    expect(() =>
      createWorkflow(db, { projectId: "nope", name: "x", prompt: "y" })
    ).toThrow();
  });
});

describe("getWorkflow", () => {
  it("returns null for an unknown id", () => {
    expect(getWorkflow(db, "missing")).toBeNull();
  });
});

// ─── listWorkflows ─────────────────────────────────────────────────────────────

describe("listWorkflows", () => {
  it("lists by project and across all projects", () => {
    db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)").run(
      "proj-2",
      "Project Two",
      "/tmp/proj-2",
      new Date().toISOString()
    );
    createWorkflow(db, { projectId: "proj-1", name: "a", prompt: "p" });
    createWorkflow(db, { projectId: "proj-2", name: "b", prompt: "p" });

    expect(listWorkflows(db, "proj-1").map((w) => w.name)).toEqual(["a"]);
    expect(listWorkflows(db).map((w) => w.name).sort()).toEqual(["a", "b"]);
  });
});

// ─── updateWorkflow ────────────────────────────────────────────────────────────

describe("updateWorkflow", () => {
  it("patches only the provided fields and persists", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "old",
      prompt: "p",
      cron: "0 9 * * *",
    });

    const updated = updateWorkflow(db, wf.id, { name: "new", cron: "0 6 * * *" })!;
    expect(updated.name).toBe("new");
    expect(updated.cron).toBe("0 6 * * *");
    expect(updated.prompt).toBe("p"); // untouched

    const fetched = getWorkflow(db, wf.id)!;
    expect(fetched.name).toBe("new");
    expect(fetched.cron).toBe("0 6 * * *");
  });

  it("re-normalizes a patched skills array", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p", skills: ["a"] });
    expect(updateWorkflow(db, wf.id, { skills: ["b", "c"] })!.skills).toEqual(["b", "c"]);
    expect(updateWorkflow(db, wf.id, { skills: [] })!.skills).toBeNull();
  });

  it("ignores explicit undefined in the patch (keeps required fields)", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "keep", prompt: "p" });
    // An explicit undefined must not overwrite a required column (would throw on bind).
    const updated = updateWorkflow(db, wf.id, { name: undefined, cron: "0 9 * * *" })!;
    expect(updated.name).toBe("keep");
    expect(updated.cron).toBe("0 9 * * *");
    expect(getWorkflow(db, wf.id)!.name).toBe("keep");
  });

  it("applies an explicit null to a nullable field", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p", cron: "0 9 * * *" });
    expect(updateWorkflow(db, wf.id, { cron: null })!.cron).toBeNull();
    expect(getWorkflow(db, wf.id)!.cron).toBeNull();
  });

  it("clears reuse_session_id when switching from reuse to fresh", () => {
    const wf = createWorkflow(db, {
      projectId: "proj-1",
      name: "x",
      prompt: "p",
      sessionStrategy: "reuse",
      reuseSessionId: "sess-7",
    });
    expect(wf.reuse_session_id).toBe("sess-7");

    const updated = updateWorkflow(db, wf.id, { session_strategy: "fresh" })!;
    expect(updated.reuse_session_id).toBeNull();
    expect(getWorkflow(db, wf.id)!.reuse_session_id).toBeNull();
  });

  it("returns null for an unknown id", () => {
    expect(updateWorkflow(db, "missing", { name: "x" })).toBeNull();
  });
});

describe("setWorkflowEnabled / setWorkflowReuseSession / updateWorkflowLastRun", () => {
  it("toggles enabled", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    setWorkflowEnabled(db, wf.id, false);
    expect(getWorkflow(db, wf.id)!.enabled).toBe(false);
    setWorkflowEnabled(db, wf.id, true);
    expect(getWorkflow(db, wf.id)!.enabled).toBe(true);
  });

  it("stores the reuse session id", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    setWorkflowReuseSession(db, wf.id, "sess-42");
    expect(getWorkflow(db, wf.id)!.reuse_session_id).toBe("sess-42");
  });

  it("stamps last_run_at", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    updateWorkflowLastRun(db, wf.id, "2026-06-21T00:00:00.000Z");
    expect(getWorkflow(db, wf.id)!.last_run_at).toBe("2026-06-21T00:00:00.000Z");
  });
});

// ─── deleteWorkflow + cascades ─────────────────────────────────────────────────

describe("deleteWorkflow", () => {
  it("removes the workflow and its runs", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    createWorkflowRun(db, { workflowId: wf.id, trigger: "manual" });

    deleteWorkflow(db, wf.id);
    expect(getWorkflow(db, wf.id)).toBeNull();
    expect(listWorkflowRuns(db, wf.id)).toEqual([]);
  });
});

describe("project cascade", () => {
  it("deleting a project deletes its workflows and runs", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    createWorkflowRun(db, { workflowId: wf.id, trigger: "cron" });

    db.prepare("DELETE FROM projects WHERE id = ?").run("proj-1");

    expect(listWorkflows(db)).toEqual([]);
    expect(listWorkflowRuns(db, wf.id)).toEqual([]);
  });
});

// ─── Run lifecycle ─────────────────────────────────────────────────────────────

describe("workflow run lifecycle", () => {
  it("creates a running run, then finalizes it to success", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    const run = createWorkflowRun(db, { workflowId: wf.id, trigger: "cron", sessionId: "sess-1" });

    expect(run.status).toBe("running");
    expect(run.ended_at).toBeNull();

    finishWorkflowRun(db, run.id, "success");
    const [stored] = listWorkflowRuns(db, wf.id);
    expect(stored.status).toBe("success");
    expect(stored.ended_at).not.toBeNull();
    expect(stored.error).toBeNull();
  });

  it("records an error message on a failed run", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    const run = createWorkflowRun(db, { workflowId: wf.id, trigger: "manual" });

    finishWorkflowRun(db, run.id, "error", "boom");
    const [stored] = listWorkflowRuns(db, wf.id);
    expect(stored.status).toBe("error");
    expect(stored.error).toBe("boom");
  });

  it("attaches a session id after creation", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    const run = createWorkflowRun(db, { workflowId: wf.id, trigger: "cron" });
    expect(run.session_id).toBeNull();

    setWorkflowRunSession(db, run.id, "sess-late");
    expect(listWorkflowRuns(db, wf.id)[0].session_id).toBe("sess-late");
  });

  it("lists runs most recent first", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    createWorkflowRun(db, { workflowId: wf.id, trigger: "manual", id: "r1" });
    createWorkflowRun(db, { workflowId: wf.id, trigger: "cron", id: "r2" });

    // Pin started_at so ordering is deterministic — creation timestamps can
    // collide within the same millisecond in fast tests. r2 is the more recent.
    db.prepare("UPDATE workflow_runs SET started_at = ? WHERE id = ?").run("2026-06-21T00:00:00.000Z", "r1");
    db.prepare("UPDATE workflow_runs SET started_at = ? WHERE id = ?").run("2026-06-21T01:00:00.000Z", "r2");

    expect(listWorkflowRuns(db, wf.id).map((r) => r.id)).toEqual(["r2", "r1"]);
  });

  it("clears the error message for non-error terminal statuses", () => {
    const wf = createWorkflow(db, { projectId: "proj-1", name: "x", prompt: "p" });
    const run = createWorkflowRun(db, { workflowId: wf.id, trigger: "cron" });

    // A caller that accidentally passes a message on success must not persist it.
    finishWorkflowRun(db, run.id, "success", "ignored");
    expect(listWorkflowRuns(db, wf.id)[0].error).toBeNull();
  });
});
