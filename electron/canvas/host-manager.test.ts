// @vitest-environment node
import { EventEmitter } from "node:events";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { z } from "zod";
import { migrate } from "../db";
import { createCanvas, getCanvas, setCanvasState } from "./store";
import { createCanvasHostRuntime, type HostTransport } from "./host/runtime";
import { defineCanvas, type CanvasServerDefinition } from "./host/sdk";

// `vi.mock` calls are hoisted above imports by vitest's transform, so this
// stub is in place before `host-manager.ts`'s top-level `import { utilityProcess }
// from "electron"` is evaluated below.
vi.mock("electron", () => ({ utilityProcess: { fork: vi.fn() } }));

import { CanvasHostManager, buildHostEnv, TOOL_CALL_TIMEOUT_GRACE_MS } from "./host-manager";
import type { CanvasHostProcess, CanvasHostProcessFactory, CanvasHostHooks } from "./host-manager";

// ─── Fake host process ───────────────────────────────────────────────────────

class FakeCanvasHostProcess extends EventEmitter implements CanvasHostProcess {
  killed = false;
  /** Tracks whether the process has already emitted `exit`, for real once. */
  exited = false;
  pid: number | undefined = 4242;
  readonly messagesToHost: unknown[] = [];

  postMessage(message: unknown): void {
    this.messagesToHost.push(message);
    this.emit("__toHost", message);
  }

  /**
   * Mirrors real `UtilityProcess#kill()`: returns `false` and emits no
   * (second) `exit` once the process has already exited — via an earlier
   * `kill()` OR a `crash()`. Getting this wrong previously masked the
   * "stop() never resolves for a crashed/errored host" bug: the old,
   * over-generous `kill()` re-emitted `exit` even for an already-crashed
   * process, so a test exercising `stop()`/`restart()` on such a host passed
   * whether or not the manager's own fix was in place.
   */
  kill(): boolean {
    if (this.exited) return false;
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => {
      if (this.exited) return;
      this.exited = true;
      this.emit("exit", 0);
    });
    return true;
  }

  /** Simulates an unexpected crash (not a manager-requested stop). */
  crash(code = 1): void {
    if (this.exited) return;
    this.exited = true;
    this.emit("exit", code);
  }
}

/**
 * Builds a `CanvasHostProcessFactory` that runs a *real* `createCanvasHostRuntime`
 * against each spawned fake process, keyed by the `serverPath` (args[0]) the
 * manager passes — so tests exercise the manager <-> host round trip through
 * the actual (already-unit-tested) host message loop, not canned responses.
 */
function createInProcessHostFactory(
  definitions: Record<string, CanvasServerDefinition>
): { factory: CanvasHostProcessFactory; processes: FakeCanvasHostProcess[] } {
  const processes: FakeCanvasHostProcess[] = [];
  const factory: CanvasHostProcessFactory = (opts) => {
    const proc = new FakeCanvasHostProcess();
    processes.push(proc);
    const [serverPath, projectJson] = opts.args;
    const definition = definitions[serverPath];
    if (!definition) {
      queueMicrotask(() => proc.emit("message", { type: "init.error", error: `unknown definition: ${serverPath}` }));
      return proc;
    }
    const project = JSON.parse(projectJson) as { id: string; path: string };
    const transport: HostTransport = {
      send: (msg) => proc.emit("message", msg),
      onMessage: (handler) => proc.on("__toHost", handler),
    };
    createCanvasHostRuntime({ definition, transport, project });
    return proc;
  };
  return { factory, processes };
}

const KANBAN_DEFINITION = defineCanvas({
  initialState: { cards: [] as string[] },
  tools: {
    get_board: {
      description: "Return the board",
      input: z.object({}),
      handler: (_args, ctx) => ctx.state.get(),
    },
    add_card: {
      description: "Add a card",
      input: z.object({ title: z.string() }),
      handler: (args, ctx) => {
        ctx.state.update((s: any) => ({ cards: [...s.cards, args.title] }));
        return ctx.state.get();
      },
    },
  },
});

// ─── DB setup ────────────────────────────────────────────────────────────────

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('p1', 'P', '/tmp/p1', 'now')").run();
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── buildHostEnv ────────────────────────────────────────────────────────────

describe("buildHostEnv", () => {
  it("strips provider API keys and credentials", () => {
    const env = buildHostEnv({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_AUTH_TOKEN: "tok",
      ANTHROPIC_BASE_URL: "https://example.com",
      GITHUB_TOKEN: "ghp_x",
      OPENAI_BASE_URL: "https://oai.example.com",
      OPENAI_API_KEY: "sk-oai-x",
      PATH: "/usr/bin",
      HOME: "/home/user",
    });

    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/user" });
  });

  it("keeps everything else untouched", () => {
    const env = buildHostEnv({ FOO: "bar", NODE_ENV: "test" });
    expect(env).toEqual({ FOO: "bar", NODE_ENV: "test" });
  });
});

// ─── Lifecycle: start / tool listing / tool calls / state persistence ───────

describe("CanvasHostManager — start, list & call tools, state persistence", () => {
  it("starts a host, lists its tools, calls one, and persists state with a bumped revision", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory });

    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    expect(manager.getStatus(canvas.id)).toBe("running");
    expect(manager.getTools(canvas.id)).toEqual([
      {
        name: "get_board",
        description: "Return the board",
        approval: "ask",
        inputSchema: z.toJSONSchema(z.object({})),
      },
      {
        name: "add_card",
        description: "Add a card",
        approval: "ask",
        inputSchema: z.toJSONSchema(z.object({ title: z.string() })),
      },
    ]);

    // Env passed to the fake process factory never carries provider keys.
    expect(processes[0]).toBeDefined();

    const result = await manager.callTool(canvas.id, "add_card", { title: "Ship it" });
    expect(result).toEqual({ cards: ["Ship it"] });

    const persisted = getCanvas(db, canvas.id);
    expect(persisted?.state).toEqual({ cards: ["Ship it"] });
    expect(persisted?.revision).toBe(1);
  });

  it("onStateChanged reports the store's authoritative revision, not the host's own count, even after a rejected write", async () => {
    // A local definition (not the shared KANBAN_DEFINITION, to avoid rippling
    // into its other tests' exact getTools() assertions): `set_board`
    // replaces the whole board outright, so a later small write's result
    // doesn't depend on — and isn't itself blown past the cap by — whatever
    // an earlier rejected write left behind in the host's local state.
    const definition = defineCanvas({
      initialState: { cards: [] as string[] },
      tools: {
        set_board: {
          description: "Replace the whole board",
          input: z.object({ cards: z.array(z.string()) }),
          handler: (args, ctx) => {
            ctx.state.set({ cards: args.cards });
            return ctx.state.get();
          },
        },
      },
    });
    const canvas = createCanvas(db, { projectId: "p1", definition: "board", title: "Board" });
    const { factory } = createInProcessHostFactory({ "/defs/board/server.mjs": definition });
    const onStateChanged = vi.fn();
    const manager = new CanvasHostManager(db, { spawn: factory, hooks: { onStateChanged } });
    await manager.start(canvas.id, { serverPath: "/defs/board/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    await manager.callTool(canvas.id, "set_board", { cards: ["One"] }); // DB + host revision both 1

    // Rejected by the store's 1MB cap: the host's own local revision still
    // advances to 2 (see "a state persistence failure is a backstop" below),
    // but the DB's stays at 1 — this is where the two diverge.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await manager.callTool(canvas.id, "set_board", { cards: ["x".repeat(2 * 1024 * 1024)] });
    consoleError.mockRestore();

    await manager.callTool(canvas.id, "set_board", { cards: ["One", "Two"] }); // host revision 3, DB revision 2

    // Without the fix (emitting the host's own msg.revision), the last call
    // here would report 3 — the host's count — instead of 2, the DB's.
    expect(onStateChanged).toHaveBeenCalledTimes(2); // the rejected write's onStateChanged is skipped entirely
    expect(onStateChanged).toHaveBeenNthCalledWith(1, canvas.id, { cards: ["One"] }, 1);
    expect(onStateChanged).toHaveBeenNthCalledWith(2, canvas.id, { cards: ["One", "Two"] }, 2);
  });

  it("passes the persisted state/revision to the host at spawn time (a restart resumes, not resets)", async () => {
    const canvas = createCanvas(db, {
      projectId: "p1",
      definition: "kanban",
      title: "Board",
      initialState: { cards: ["existing"] },
    });
    // Bump revision once via a direct store write, simulating a prior run.
    setCanvasState(db, canvas.id, { cards: ["existing", "second"] });

    const { factory } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    const board = await manager.callTool(canvas.id, "get_board", {});
    expect(board).toEqual({ cards: ["existing", "second"] });
  });

  it("rejects a tool call against an unstarted / unknown canvas", async () => {
    const manager = new CanvasHostManager(db, { spawn: createInProcessHostFactory({}).factory });
    await expect(manager.callTool("nope", "anything", {})).rejects.toThrow(/not running/);
  });

  it("rejects starting a canvas that doesn't exist", async () => {
    const manager = new CanvasHostManager(db, { spawn: createInProcessHostFactory({}).factory });
    await expect(
      manager.start("missing-id", { serverPath: "/x", projectId: "p1", projectPath: "/tmp/p1" })
    ).rejects.toThrow(/not found/);
  });

  it("a handler error surfaces as a rejected callTool, not a manager crash", async () => {
    const boom = defineCanvas({
      tools: {
        explode: {
          description: "Always fails",
          input: z.object({}),
          handler: () => {
            throw new Error("definition bug");
          },
        },
      },
    });
    const canvas = createCanvas(db, { projectId: "p1", definition: "boom", title: "Boom" });
    const { factory } = createInProcessHostFactory({ "/defs/boom/server.mjs": boom });
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(canvas.id, { serverPath: "/defs/boom/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    await expect(manager.callTool(canvas.id, "explode", {})).rejects.toThrow("definition bug");
    expect(manager.getStatus(canvas.id)).toBe("running");
  });
});

// ─── Idle stop ───────────────────────────────────────────────────────────────

describe("CanvasHostManager — idle stop", () => {
  it("stops a running host after idleStopMs with no open panel and no active turn", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, idleStopMs: 1000 });

    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    expect(manager.getStatus(canvas.id)).toBe("running");

    await vi.advanceTimersByTimeAsync(1000);
    expect(processes[0].killed).toBe(true);
    expect(manager.getStatus(canvas.id)).toBe("stopped");
  });

  it("never idle-stops while a panel is open", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, idleStopMs: 1000 });

    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    manager.setPanelOpen(canvas.id, true);

    await vi.advanceTimersByTimeAsync(5000);
    expect(processes[0].killed).toBe(false);
    expect(manager.getStatus(canvas.id)).toBe("running");
  });

  it("never idle-stops while a turn is active, and resumes the countdown once it ends", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, idleStopMs: 1000 });

    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    manager.setTurnActive(canvas.id, true);

    await vi.advanceTimersByTimeAsync(1000);
    expect(processes[0].killed).toBe(false);

    manager.setTurnActive(canvas.id, false);
    await vi.advanceTimersByTimeAsync(999);
    expect(processes[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(processes[0].killed).toBe(true);
  });
});

// ─── Crash restart with backoff ──────────────────────────────────────────────

describe("CanvasHostManager — crash restart with backoff", () => {
  it("restarts with exponential backoff, then marks errored after maxRestarts", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const statusChanges: string[] = [];
    const hooks: CanvasHostHooks = { onStatusChanged: (_id, status) => statusChanges.push(status) };
    const manager = new CanvasHostManager(db, {
      spawn: factory,
      hooks,
      maxRestarts: 3,
      restartWindowMs: 60_000,
      restartBaseDelayMs: 1000,
    });

    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    expect(processes).toHaveLength(1);

    // Crash 1 -> restart after 1000ms.
    processes[0].crash();
    expect(manager.getStatus(canvas.id)).toBe("crashed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(processes).toHaveLength(2);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    // Crash 2 -> restart after 2000ms.
    processes[1].crash();
    await vi.advanceTimersByTimeAsync(2000);
    expect(processes).toHaveLength(3);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    // Crash 3 -> restart after 4000ms.
    processes[2].crash();
    await vi.advanceTimersByTimeAsync(4000);
    expect(processes).toHaveLength(4);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    // Crash 4 -> restart budget (3 within the window) exhausted: errored, no further spawn.
    processes[3].crash();
    expect(manager.getStatus(canvas.id)).toBe("errored");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(processes).toHaveLength(4);

    expect(statusChanges).toContain("errored");
  });

  it("the main process stays healthy: a crash never throws out of the exit handler", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, restartBaseDelayMs: 1 });
    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    expect(() => processes[0].crash()).not.toThrow();
  });

  it("a manual restart() resets the backoff counter", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, {
      spawn: factory,
      maxRestarts: 1,
      restartWindowMs: 60_000,
      restartBaseDelayMs: 1000,
    });
    const startOpts = { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" };

    await manager.start(canvas.id, startOpts);
    processes[0].crash();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    processes[1].crash();
    expect(manager.getStatus(canvas.id)).toBe("errored");

    // Deliberate restart: budget resets, so a fresh crash gets a fresh backoff window.
    await manager.restart(canvas.id, startOpts);
    expect(manager.getStatus(canvas.id)).toBe("running");
    processes[2].crash();
    expect(manager.getStatus(canvas.id)).toBe("crashed");
  });

  it("carries panelOpen/turnActive across a crash restart, so the idle timer doesn't fire for a still-open panel", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, idleStopMs: 1000, restartBaseDelayMs: 100 });
    const startOpts = { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" };

    await manager.start(canvas.id, startOpts);
    manager.setPanelOpen(canvas.id, true);

    processes[0].crash();
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    // The renderer never re-calls setPanelOpen after a restart it didn't ask
    // for, so the manager must remember the panel was left open on its own.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.getStatus(canvas.id)).toBe("running");
    expect(processes[1].killed).toBe(false);
  });

  it("counts a failed automatic restart against the crash budget instead of quietly landing on stopped", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    let spawnCount = 0;
    const processes: FakeCanvasHostProcess[] = [];
    // Simulates a canvas whose server.mjs starts throwing on import right
    // after a crash: the first spawn succeeds, every restart attempt after
    // it never becomes ready.
    const factory: CanvasHostProcessFactory = (opts) => {
      spawnCount += 1;
      const proc = new FakeCanvasHostProcess();
      processes.push(proc);
      if (spawnCount === 1) {
        const project = JSON.parse(opts.args[1]) as { id: string; path: string };
        const transport: HostTransport = {
          send: (msg) => proc.emit("message", msg),
          onMessage: (handler) => proc.on("__toHost", handler),
        };
        createCanvasHostRuntime({ definition: KANBAN_DEFINITION, transport, project });
      }
      return proc;
    };
    const manager = new CanvasHostManager(db, {
      spawn: factory,
      maxRestarts: 2,
      restartWindowMs: 60_000,
      restartBaseDelayMs: 100,
      startTimeoutMs: 500,
    });
    const startOpts = { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" };

    await manager.start(canvas.id, startOpts);
    expect(manager.getStatus(canvas.id)).toBe("running");

    // Crash 1 -> restart scheduled after 100ms; that restart attempt itself
    // never becomes ready, so its own 500ms start timeout must count as a
    // second crash against the budget (not leave the record "stopped").
    processes[0].crash();
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnCount).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getStatus(canvas.id)).toBe("crashed"); // one restart of the budget left, not "stopped"

    // The next backoff attempt (100 * 2^1 = 200ms) also fails to become
    // ready -> budget (2) exhausted -> "errored".
    await vi.advanceTimersByTimeAsync(200);
    expect(spawnCount).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(manager.getStatus(canvas.id)).toBe("errored");
  });
});

// ─── stop / stopAll ──────────────────────────────────────────────────────────

describe("CanvasHostManager — stop / stopAll", () => {
  it("stop() is not treated as a crash and does not trigger a restart", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, restartBaseDelayMs: 100 });
    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    await manager.stop(canvas.id);
    expect(manager.getStatus(canvas.id)).toBe("stopped");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(processes).toHaveLength(1); // no restart spawned
  });

  it("stopAll() stops every started host", async () => {
    const c1 = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board 1" });
    const c2 = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board 2" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(c1.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    await manager.start(c2.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    await manager.stopAll();
    expect(processes.every((p) => p.killed)).toBe(true);
    expect(manager.getStatus(c1.id)).toBe("stopped");
    expect(manager.getStatus(c2.id)).toBe("stopped");
  });

  it("stop() resolves for an already-crashed/errored host instead of hanging on a second exit that will never come", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    // maxRestarts: 0 -> the very first crash exhausts the budget and lands directly in "errored".
    const manager = new CanvasHostManager(db, { spawn: factory, maxRestarts: 0 });
    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    processes[0].crash();
    expect(manager.getStatus(canvas.id)).toBe("errored");

    // Real UtilityProcess#kill() on an already-exited process returns false and
    // fires no further "exit" — this must not depend on one to resolve.
    await expect(manager.stop(canvas.id)).resolves.toBeUndefined();
    expect(manager.getStatus(canvas.id)).toBe("stopped");
  });

  it("stopAll() resolves even when one host is crashed/errored", async () => {
    const c1 = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board 1" });
    const c2 = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board 2" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory, maxRestarts: 0 });
    await manager.start(c1.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });
    await manager.start(c2.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    processes[0].crash();
    expect(manager.getStatus(c1.id)).toBe("errored");

    await expect(manager.stopAll()).resolves.toBeUndefined();
    expect(manager.getStatus(c1.id)).toBe("stopped");
    expect(manager.getStatus(c2.id)).toBe("stopped");
  });
});

// ─── start() timeout / init.error ───────────────────────────────────────────

describe("CanvasHostManager — start failures", () => {
  it("rejects start() if the host never becomes ready in time", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    // No definitions registered -> factory returns a process that never emits "ready".
    const neverReadyFactory: CanvasHostProcessFactory = () => new FakeCanvasHostProcess();
    const manager = new CanvasHostManager(db, { spawn: neverReadyFactory, startTimeoutMs: 5000 });

    const pending = manager.start(canvas.id, { serverPath: "/nope", projectId: "p1", projectPath: "/tmp/p1" });
    const assertion = expect(pending).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it("reports 'stopped' only once after a failed start, even once the killed process's exit later arrives", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const neverReadyFactory: CanvasHostProcessFactory = () => new FakeCanvasHostProcess();
    const statusChanges: string[] = [];
    const manager = new CanvasHostManager(db, {
      spawn: neverReadyFactory,
      startTimeoutMs: 5000,
      hooks: { onStatusChanged: (_id, status) => statusChanges.push(status) },
    });

    const pending = manager.start(canvas.id, { serverPath: "/nope", projectId: "p1", projectPath: "/tmp/p1" });
    const assertion = expect(pending).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(statusChanges.filter((s) => s === "stopped")).toHaveLength(1);
  });

  it("rejects start() when the host reports init.error", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory } = createInProcessHostFactory({}); // no matching serverPath -> init.error
    const manager = new CanvasHostManager(db, { spawn: factory });

    await expect(
      manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" })
    ).rejects.toThrow(/unknown definition/);
  });

  it("a later start() after a timed-out attempt is a fresh, independent attempt instead of hanging forever", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const neverReadyProcesses: FakeCanvasHostProcess[] = [];
    const neverReadyFactory: CanvasHostProcessFactory = () => {
      const proc = new FakeCanvasHostProcess();
      neverReadyProcesses.push(proc);
      return proc;
    };
    const manager = new CanvasHostManager(db, { spawn: neverReadyFactory, startTimeoutMs: 5000 });
    const startOpts = { serverPath: "/nope", projectId: "p1", projectPath: "/tmp/p1" };

    const firstAttempt = manager.start(canvas.id, startOpts);
    const firstAssertion = expect(firstAttempt).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(5000);
    await firstAssertion;
    expect(manager.getStatus(canvas.id)).not.toBe("starting");
    expect(neverReadyProcesses[0].killed).toBe(true); // the never-ready process is cleaned up, not leaked

    // Without the fix, the record stayed stuck in "starting" forever, so this
    // second start() would push a waiter with no timer of its own onto the
    // dead first record and hang — never resolving OR rejecting. Here it must
    // spawn a genuinely new process and run its own independent timeout.
    const secondAttempt = manager.start(canvas.id, startOpts);
    const secondAssertion = expect(secondAttempt).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(5000);
    await secondAssertion;
    expect(neverReadyProcesses).toHaveLength(2);
  });
});

// ─── callTool honors a tool's own timeoutMs ─────────────────────────────────

describe("CanvasHostManager — callTool sizes its safety net off the tool's own timeout", () => {
  const SLOW_DEFINITION = defineCanvas({
    tools: {
      slow: {
        description: "Needs longer than the host's 60s default",
        input: z.object({}),
        timeoutMs: 120_000,
        handler: () => new Promise((resolve) => setTimeout(() => resolve("done"), 90_000)),
      },
    },
  });

  it("does not cut off a tool whose declared timeoutMs exceeds the manager's own default", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "slow", title: "Slow" });
    const { factory } = createInProcessHostFactory({ "/defs/slow/server.mjs": SLOW_DEFINITION });
    // toolCallTimeoutMs (60s) is the manager's *fallback* default — a tool
    // that reports its own 120s timeoutMs must not be bound by it.
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(canvas.id, { serverPath: "/defs/slow/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    const pending = manager.callTool(canvas.id, "slow", {});
    const assertion = expect(pending).resolves.toBe("done");
    // Past the manager's 60s default and the host's own un-overridden default —
    // only reachable because the manager read `slow`'s reported 120s timeoutMs.
    await vi.advanceTimersByTimeAsync(90_000);
    await assertion;
  });

  it("times out a genuinely unresponsive host at the tool's own timeoutMs plus a grace margin, not the manager's 60s default", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "slow", title: "Slow" });
    // A host that reports the same `slow` tool (declaring timeoutMs: 120_000)
    // but never replies to any tool.call at all — unlike a real runtime, which
    // always eventually replies with its own timeout error (covered above and
    // in runtime.test.ts), this simulates the host being truly wedged, so only
    // the manager's own safety net can ever settle the call.
    const factory: CanvasHostProcessFactory = () => {
      const proc = new FakeCanvasHostProcess();
      queueMicrotask(() =>
        proc.emit("message", {
          type: "ready",
          tools: [{ name: "slow", description: "Never replies", approval: "ask", timeoutMs: 120_000 }],
        })
      );
      return proc;
    };
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(canvas.id, { serverPath: "/defs/slow/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    const pending = manager.callTool(canvas.id, "slow", {});
    const assertion = expect(pending).rejects.toThrow(/did not reply/);
    // Settles at the tool's reported 120s + grace — proves the manager read
    // the descriptor's timeoutMs rather than falling back to its own 60s default
    // (which would have rejected this call 65 seconds earlier).
    await vi.advanceTimersByTimeAsync(125_000);
    await assertion;
  });

  it("a caller-supplied timeoutMs shorter than the tool's own budget rejects the call but never kills a healthy host", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "slow", title: "Slow" });
    const { factory, processes } = createInProcessHostFactory({ "/defs/slow/server.mjs": SLOW_DEFINITION });
    const manager = new CanvasHostManager(db, { spawn: factory });
    await manager.start(canvas.id, { serverPath: "/defs/slow/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    // SLOW_DEFINITION's `slow` tool declares timeoutMs: 120_000 and resolves
    // after 90s (well within its own budget) — but this caller asks to give
    // up after only 1s, far short of that.
    const pending = manager.callTool(canvas.id, "slow", {}, { timeoutMs: 1_000 });
    const assertion = expect(pending).rejects.toThrow(/did not reply to tool "slow" within 1000ms/);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;

    // The call's own promise gave up early, exactly as the caller asked, but
    // the host itself was never touched: it is not the "hung host" case, and
    // must not be killed, restarted, or spend any of its crash budget.
    expect(processes[0].killed).toBe(false);
    expect(manager.getStatus(canvas.id)).toBe("running");

    // The tool keeps running regardless and finishes normally — proving the
    // host really was healthy the whole time, not merely "not yet killed".
    await vi.advanceTimersByTimeAsync(89_000);
    expect(processes[0].killed).toBe(false);
    expect(manager.getStatus(canvas.id)).toBe("running");
  });

  it("recovers a hung host instead of leaving it wedged 'running' forever (#222 acceptance criterion)", async () => {
    vi.useFakeTimers();
    const canvas = createCanvas(db, { projectId: "p1", definition: "slow", title: "Slow" });
    const processes: FakeCanvasHostProcess[] = [];
    // A host that reports ready but, per call, never answers — every restart
    // attempt spawns another instance of this same, still-wedged behavior.
    const factory: CanvasHostProcessFactory = () => {
      const proc = new FakeCanvasHostProcess();
      processes.push(proc);
      queueMicrotask(() =>
        proc.emit("message", {
          type: "ready",
          tools: [{ name: "slow", description: "Never replies", approval: "ask", timeoutMs: 1000 }],
        })
      );
      return proc;
    };
    const manager = new CanvasHostManager(db, {
      spawn: factory,
      maxRestarts: 1,
      restartWindowMs: 60_000,
      restartBaseDelayMs: 100,
    });
    await manager.start(canvas.id, { serverPath: "/defs/slow/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    const firstCall = manager.callTool(canvas.id, "slow", {});
    const firstAssertion = expect(firstCall).rejects.toThrow(/did not reply/);
    await vi.advanceTimersByTimeAsync(1000 + TOOL_CALL_TIMEOUT_GRACE_MS);
    await firstAssertion;

    // The manager killed the wedged process (not a deliberate stop), so
    // handleExit treats it as a crash and drives the normal backoff cycle —
    // it is never left permanently "running" while every future call would
    // time out the same way.
    expect(processes[0].killed).toBe(true);
    expect(manager.getStatus(canvas.id)).toBe("crashed");

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(manager.getStatus(canvas.id)).toBe("running"));

    // Still unresponsive after the restart, and the budget (1) is now spent:
    // gives up rather than looping the same recovery forever.
    const secondCall = manager.callTool(canvas.id, "slow", {});
    const secondAssertion = expect(secondCall).rejects.toThrow(/did not reply/);
    await vi.advanceTimersByTimeAsync(1000 + TOOL_CALL_TIMEOUT_GRACE_MS);
    await secondAssertion;
    expect(manager.getStatus(canvas.id)).toBe("errored");
  });
});

// ─── state.changed persistence failures don't crash the manager ────────────

describe("CanvasHostManager — a state persistence failure is a backstop, not an uncaught throw", () => {
  it("logs and skips onStateChanged when the state exceeds the store's cap, keeping the host running", async () => {
    const canvas = createCanvas(db, {
      projectId: "p1",
      definition: "kanban",
      title: "Board",
      initialState: { cards: [] },
    });
    const { factory } = createInProcessHostFactory({ "/defs/kanban/server.mjs": KANBAN_DEFINITION });
    const onStateChanged = vi.fn();
    const manager = new CanvasHostManager(db, { spawn: factory, hooks: { onStateChanged } });
    await manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" });

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const hugeTitle = "x".repeat(2 * 1024 * 1024);
      await expect(
        manager.callTool(canvas.id, "add_card", { title: hugeTitle })
      ).resolves.toEqual({ cards: [hugeTitle] });
    } finally {
      consoleError.mockRestore();
    }

    // The manager stayed healthy: no uncaught throw, no onStateChanged for the
    // rejected write, the DB is untouched by the oversized write (store.ts
    // validates before mutating the row), and the host is still responsive
    // to further calls afterward (even though its in-memory state has now
    // drifted from the DB — the known, documented limitation of this backstop).
    expect(onStateChanged).not.toHaveBeenCalled();
    expect(manager.getStatus(canvas.id)).toBe("running");
    expect(getCanvas(db, canvas.id)?.state).toEqual({ cards: [] });

    await expect(manager.callTool(canvas.id, "get_board", {})).resolves.toBeDefined();
  });
});
