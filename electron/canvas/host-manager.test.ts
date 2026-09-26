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

import { CanvasHostManager, buildHostEnv } from "./host-manager";
import type { CanvasHostProcess, CanvasHostProcessFactory, CanvasHostHooks } from "./host-manager";

// ─── Fake host process ───────────────────────────────────────────────────────

class FakeCanvasHostProcess extends EventEmitter implements CanvasHostProcess {
  killed = false;
  pid: number | undefined = 4242;
  readonly messagesToHost: unknown[] = [];

  postMessage(message: unknown): void {
    this.messagesToHost.push(message);
    this.emit("__toHost", message);
  }

  kill(): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0));
    return true;
  }

  /** Simulates an unexpected crash (not a manager-requested stop). */
  crash(code = 1): void {
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
      { name: "get_board", description: "Return the board", approval: "ask" },
      { name: "add_card", description: "Add a card", approval: "ask" },
    ]);

    // Env passed to the fake process factory never carries provider keys.
    expect(processes[0]).toBeDefined();

    const result = await manager.callTool(canvas.id, "add_card", { title: "Ship it" });
    expect(result).toEqual({ cards: ["Ship it"] });

    const persisted = getCanvas(db, canvas.id);
    expect(persisted?.state).toEqual({ cards: ["Ship it"] });
    expect(persisted?.revision).toBe(1);
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

  it("rejects start() when the host reports init.error", async () => {
    const canvas = createCanvas(db, { projectId: "p1", definition: "kanban", title: "Board" });
    const { factory } = createInProcessHostFactory({}); // no matching serverPath -> init.error
    const manager = new CanvasHostManager(db, { spawn: factory });

    await expect(
      manager.start(canvas.id, { serverPath: "/defs/kanban/server.mjs", projectId: "p1", projectPath: "/tmp/p1" })
    ).rejects.toThrow(/unknown definition/);
  });
});
