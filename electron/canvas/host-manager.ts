/**
 * `CanvasHostManager` (#222) — starts, stops, and talks to canvas host
 * processes. Each active canvas instance gets its own Electron
 * `utilityProcess`: a crash, a hang, or a busy loop in canvas server code must
 * never affect the main process, so every host is isolated and supervised
 * from here.
 *
 * All launching goes through {@link spawnCanvasHost} — the one seam a future
 * OS-level sandbox replaces (see the design doc's "OS-level sandboxing").
 * Tests inject a fake `spawn` factory (the same pattern as
 * `_setCodexFactoryForTests`) so the manager's lifecycle logic — start,
 * message routing, idle-stop, crash backoff — is fully unit-testable without
 * a real subprocess.
 */
import * as crypto from "node:crypto";
import * as nodePath from "node:path";
import { utilityProcess } from "electron";
import type { Database } from "better-sqlite3";
import { getCanvas, setCanvasState } from "./store";
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  HostToMainMessageSchema,
  type CanvasToolDescriptor,
  type HostToMainMessage,
} from "./host-protocol";

// ─── Process abstraction (test seam) ────────────────────────────────────────

/** The subset of Electron's `UtilityProcess` this manager depends on. */
export interface CanvasHostProcess {
  postMessage(message: unknown): void;
  on(event: "message", listener: (message: unknown) => void): void;
  on(event: "exit", listener: (code: number) => void): void;
  kill(): boolean;
  readonly pid?: number;
}

export interface SpawnCanvasHostOptions {
  modulePath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export type CanvasHostProcessFactory = (opts: SpawnCanvasHostOptions) => CanvasHostProcess;

/**
 * The default host launcher: an Electron `utilityProcess.fork()`. No
 * `BrowserWindow`, no IPC handlers, no `window.electronAPI` — the host only
 * ever talks to main over this process's own message channel.
 */
export const spawnCanvasHost: CanvasHostProcessFactory = (opts) =>
  utilityProcess.fork(opts.modulePath, opts.args, {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdio: "pipe",
    serviceName: "aichemist-canvas-host",
  });

/** Resolves the compiled host bootstrap script, built alongside `electron/main.ts`. */
export function resolveCanvasHostEntryPath(): string {
  return nodePath.join(__dirname, "host", "entry.js");
}

// ─── Host environment ────────────────────────────────────────────────────────

/** Env var name prefixes stripped from a host's environment. */
const STRIPPED_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_"];
/** Exact env var names stripped from a host's environment. */
const STRIPPED_ENV_NAMES = new Set(["GITHUB_TOKEN"]);

/**
 * AIchemist's own environment, minus every provider API key/credential
 * (`ANTHROPIC_*`, `GITHUB_TOKEN`, `OPENAI_*`, …). A canvas that needs a
 * credential declares it and the user supplies it (a later phase) rather than
 * inheriting every provider key by default.
 */
export function buildHostEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (STRIPPED_ENV_NAMES.has(key)) continue;
    if (STRIPPED_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    env[key] = value;
  }
  return env;
}

// ─── Manager types ───────────────────────────────────────────────────────────

/**
 * `"crashed"` is the transient state between an unexpected exit and the next
 * backoff-scheduled restart attempt; `"errored"` is the terminal state once
 * `maxRestarts` is exhausted (a manual `restart()` is the only way out).
 */
export type CanvasHostStatus = "starting" | "running" | "stopped" | "crashed" | "errored";

/**
 * Side-effect hooks fired as a host's state changes. All optional and
 * fail-safe — a hook that throws never breaks host supervision. There is no
 * default implementation (unlike `WorkflowRunHooks`): wiring these to
 * `CANVAS_EVENT` pushes and to the UI is a later issue's job.
 */
export interface CanvasHostHooks {
  /** A tool- or UI-triggered state write landed and was persisted. */
  onStateChanged?(canvasId: string, state: unknown, revision: number): void;
  onUiMessage?(canvasId: string, message: unknown): void;
  onAgentSend?(canvasId: string, text: string, sessionId: string | undefined): void;
  onLog?(canvasId: string, level: "log" | "warn" | "error", args: unknown[]): void;
  onStatusChanged?(canvasId: string, status: CanvasHostStatus): void;
}

export interface StartCanvasHostOptions {
  /** Absolute path to the definition's `server.mjs`. */
  serverPath: string;
  projectId: string;
  projectPath: string;
}

export interface CanvasHostManagerOptions {
  spawn?: CanvasHostProcessFactory;
  entryPath?: string;
  hooks?: CanvasHostHooks;
  /** No open panel + no running turn for this long stops the host. Default 10 min. */
  idleStopMs?: number;
  /** Crash-restart attempts allowed within `restartWindowMs` before erroring. Default 3. */
  maxRestarts?: number;
  /** Sliding window the restart count is measured over. Default 60 s. */
  restartWindowMs?: number;
  /** Backoff base — attempt N waits `restartBaseDelayMs * 2^(N-1)`. Default 1 s. */
  restartBaseDelayMs?: number;
  /** How long `start()` waits for the host's `ready` message. Default 10 s. */
  startTimeoutMs?: number;
  /** Manager-side safety net if a host never replies to a tool call at all. */
  toolCallTimeoutMs?: number;
}

export class CanvasHostTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasHostTimeoutError";
  }
}

interface PendingCall {
  resolve(result: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve(): void;
  reject(err: Error): void;
}

interface HostRecord {
  canvasId: string;
  process: CanvasHostProcess;
  startOpts: StartCanvasHostOptions;
  status: CanvasHostStatus;
  tools: CanvasToolDescriptor[];
  pendingCalls: Map<string, PendingCall>;
  panelOpen: boolean;
  turnActive: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
  startTimer: ReturnType<typeof setTimeout> | null;
  restartTimestamps: number[];
  /** Set while `stop()` is tearing this host down, so its `exit` isn't treated as a crash. */
  stopping: boolean;
  stopWaiters: Array<() => void>;
  readyWaiters: ReadyWaiter[];
}

// ─── Manager ─────────────────────────────────────────────────────────────────

export class CanvasHostManager {
  private readonly hosts = new Map<string, HostRecord>();
  private readonly spawn: CanvasHostProcessFactory;
  private readonly entryPath: string;
  private readonly hooks: CanvasHostHooks;
  private readonly idleStopMs: number;
  private readonly maxRestarts: number;
  private readonly restartWindowMs: number;
  private readonly restartBaseDelayMs: number;
  private readonly startTimeoutMs: number;
  private readonly toolCallTimeoutMs: number;

  constructor(
    private readonly db: Database,
    options?: CanvasHostManagerOptions
  ) {
    this.spawn = options?.spawn ?? spawnCanvasHost;
    this.entryPath = options?.entryPath ?? resolveCanvasHostEntryPath();
    this.hooks = options?.hooks ?? {};
    this.idleStopMs = options?.idleStopMs ?? 10 * 60 * 1000;
    this.maxRestarts = options?.maxRestarts ?? 3;
    this.restartWindowMs = options?.restartWindowMs ?? 60_000;
    this.restartBaseDelayMs = options?.restartBaseDelayMs ?? 1000;
    this.startTimeoutMs = options?.startTimeoutMs ?? 10_000;
    this.toolCallTimeoutMs = options?.toolCallTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  }

  private callHook<K extends keyof CanvasHostHooks>(
    name: K,
    ...args: Parameters<NonNullable<CanvasHostHooks[K]>>
  ): void {
    const hook = this.hooks[name] as ((...a: unknown[]) => void) | undefined;
    if (!hook) return;
    try {
      hook(...args);
    } catch (err) {
      console.error(`[canvas-host-manager] hook "${name}" threw:`, err);
    }
  }

  private setStatus(record: HostRecord, status: CanvasHostStatus): void {
    record.status = status;
    this.callHook("onStatusChanged", record.canvasId, status);
  }

  /** Current status, or `undefined` if no host has ever been started for this canvas. */
  getStatus(canvasId: string): CanvasHostStatus | undefined {
    return this.hosts.get(canvasId)?.status;
  }

  /** The attached definition's tools, as reported by its last `ready` message. */
  getTools(canvasId: string): CanvasToolDescriptor[] | undefined {
    return this.hosts.get(canvasId)?.tools;
  }

  /**
   * Starts a host for a canvas instance (or joins the same wait if one is
   * already starting; returns immediately if one is already running).
   * Resolves once the host reports `ready`; rejects if it doesn't within
   * `startTimeoutMs`, or the canvas instance doesn't exist.
   */
  start(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    const existing = this.hosts.get(canvasId);
    if (existing?.status === "running") return Promise.resolve();
    if (existing?.status === "starting") {
      return new Promise((resolve, reject) => existing.readyWaiters.push({ resolve, reject }));
    }
    if (existing?.restartTimer) {
      clearTimeout(existing.restartTimer);
      existing.restartTimer = null;
    }

    const canvas = getCanvas(this.db, canvasId);
    if (!canvas) {
      return Promise.reject(new Error(`Canvas not found: ${canvasId}`));
    }
    return this.spawnHost(canvasId, opts, canvas.state, canvas.revision);
  }

  private spawnHost(
    canvasId: string,
    opts: StartCanvasHostOptions,
    state: unknown,
    revision: number
  ): Promise<void> {
    const prior = this.hosts.get(canvasId);
    const childProcess = this.spawn({
      modulePath: this.entryPath,
      args: [opts.serverPath, JSON.stringify({ id: opts.projectId, path: opts.projectPath })],
      cwd: opts.projectPath,
      env: buildHostEnv(process.env),
    });

    const record: HostRecord = {
      canvasId,
      process: childProcess,
      startOpts: opts,
      status: "starting",
      tools: [],
      pendingCalls: new Map(),
      panelOpen: false,
      turnActive: false,
      idleTimer: null,
      restartTimer: null,
      startTimer: null,
      restartTimestamps: prior?.restartTimestamps ?? [],
      stopping: false,
      stopWaiters: [],
      readyWaiters: [],
    };
    this.hosts.set(canvasId, record);
    this.callHook("onStatusChanged", canvasId, "starting");

    const readyPromise = new Promise<void>((resolve, reject) => {
      record.readyWaiters.push({ resolve, reject });
    });

    record.startTimer = setTimeout(() => {
      this.rejectReadyWaiters(
        record,
        new CanvasHostTimeoutError(`Canvas host did not become ready within ${this.startTimeoutMs}ms`)
      );
    }, this.startTimeoutMs);

    childProcess.on("message", (raw) => this.handleMessage(record, raw));
    childProcess.on("exit", (code) => this.handleExit(record, code));

    childProcess.postMessage({ type: "init", state, revision });

    return readyPromise;
  }

  private resolveReadyWaiters(record: HostRecord): void {
    if (record.startTimer) {
      clearTimeout(record.startTimer);
      record.startTimer = null;
    }
    const waiters = record.readyWaiters;
    record.readyWaiters = [];
    for (const waiter of waiters) waiter.resolve();
  }

  private rejectReadyWaiters(record: HostRecord, err: Error): void {
    if (record.startTimer) {
      clearTimeout(record.startTimer);
      record.startTimer = null;
    }
    const waiters = record.readyWaiters;
    record.readyWaiters = [];
    for (const waiter of waiters) waiter.reject(err);
  }

  private handleMessage(record: HostRecord, raw: unknown): void {
    const parsed = HostToMainMessageSchema.safeParse(raw);
    if (!parsed.success) return;
    const msg: HostToMainMessage = parsed.data;

    switch (msg.type) {
      case "ready":
        record.tools = msg.tools;
        this.setStatus(record, "running");
        this.resolveReadyWaiters(record);
        this.scheduleIdleCheck(record);
        break;
      case "init.error":
        console.error(`[canvas-host-manager] host ${record.canvasId} failed to initialize:`, msg.error);
        this.rejectReadyWaiters(record, new Error(msg.error));
        break;
      case "tool.result": {
        const pending = record.pendingCalls.get(msg.callId);
        if (!pending) break;
        clearTimeout(pending.timer);
        record.pendingCalls.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error?.message ?? "Canvas tool call failed"));
        break;
      }
      case "state.changed":
        setCanvasState(this.db, record.canvasId, msg.state);
        this.callHook("onStateChanged", record.canvasId, msg.state, msg.revision);
        break;
      case "ui.message":
        this.callHook("onUiMessage", record.canvasId, msg.message);
        break;
      case "agent.send":
        this.callHook("onAgentSend", record.canvasId, msg.text, msg.sessionId);
        break;
      case "log":
        this.callHook("onLog", record.canvasId, msg.level, msg.args);
        break;
      default:
        break;
    }
  }

  private handleExit(record: HostRecord, _code: number): void {
    if (record.idleTimer) clearTimeout(record.idleTimer);

    for (const pending of record.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Canvas host exited before replying"));
    }
    record.pendingCalls.clear();

    if (record.stopping) {
      this.setStatus(record, "stopped");
      this.rejectReadyWaiters(record, new Error("Canvas host was stopped"));
      const waiters = record.stopWaiters;
      record.stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }

    this.rejectReadyWaiters(record, new Error("Canvas host exited before becoming ready"));

    const now = Date.now();
    record.restartTimestamps = record.restartTimestamps.filter((t) => now - t < this.restartWindowMs);
    record.restartTimestamps.push(now);

    if (record.restartTimestamps.length > this.maxRestarts) {
      this.setStatus(record, "errored");
      return;
    }

    this.setStatus(record, "crashed");
    const attempt = record.restartTimestamps.length;
    const delayMs = this.restartBaseDelayMs * 2 ** (attempt - 1);
    record.restartTimer = setTimeout(() => {
      const canvas = getCanvas(this.db, record.canvasId);
      if (!canvas) return; // Deleted while backing off — nothing left to restart.
      this.spawnHost(record.canvasId, record.startOpts, canvas.state, canvas.revision).catch((err: unknown) => {
        console.error(`[canvas-host-manager] restart of ${record.canvasId} failed:`, err);
      });
    }, delayMs);
  }

  /**
   * Sends a tool call to a running host and resolves with its result (or
   * rejects with the tool's error). Rejects immediately if the host isn't
   * running, and after `toolCallTimeoutMs` if the host never replies at all
   * (on top of — not instead of — the host's own per-tool timeout, which
   * produces an ordinary error result long before this fires in practice).
   */
  callTool(canvasId: string, tool: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const record = this.hosts.get(canvasId);
    if (!record || record.status !== "running") {
      return Promise.reject(new Error(`Canvas host is not running: ${canvasId}`));
    }

    const callId = crypto.randomUUID();
    const timeoutMs = opts?.timeoutMs ?? this.toolCallTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.pendingCalls.delete(callId);
        reject(new CanvasHostTimeoutError(`Canvas host did not reply to tool "${tool}" within ${timeoutMs}ms`));
      }, timeoutMs);
      record.pendingCalls.set(callId, { resolve, reject, timer });
      record.process.postMessage({ type: "tool.call", callId, tool, args });
    });
  }

  /** Delivers a UI message to a running host's `onUiMessage`. No-op if not running. */
  sendUiMessage(canvasId: string, message: unknown): void {
    const record = this.hosts.get(canvasId);
    if (!record || record.status !== "running") return;
    record.process.postMessage({ type: "ui.message", message });
  }

  /** Stops a host deliberately — its exit is never treated as a crash. Resolves once it has exited. */
  stop(canvasId: string): Promise<void> {
    const record = this.hosts.get(canvasId);
    if (!record || record.status === "stopped") return Promise.resolve();
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = null;
    }
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
    record.stopping = true;
    const stopped = new Promise<void>((resolve) => record.stopWaiters.push(resolve));
    record.process.kill();
    return stopped;
  }

  /** Stops and restarts a host, resetting its crash-backoff counter. */
  async restart(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    await this.stop(canvasId);
    const record = this.hosts.get(canvasId);
    if (record) record.restartTimestamps = [];
    await this.start(canvasId, opts);
  }

  /** Marks whether a panel for this canvas is currently open (idle-stop bookkeeping). */
  setPanelOpen(canvasId: string, open: boolean): void {
    const record = this.hosts.get(canvasId);
    if (!record) return;
    record.panelOpen = open;
    this.scheduleIdleCheck(record);
  }

  /** Marks whether a turn is currently running against this canvas (idle-stop bookkeeping). */
  setTurnActive(canvasId: string, active: boolean): void {
    const record = this.hosts.get(canvasId);
    if (!record) return;
    record.turnActive = active;
    this.scheduleIdleCheck(record);
  }

  private scheduleIdleCheck(record: HostRecord): void {
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }
    if (record.status !== "running" || record.panelOpen || record.turnActive) return;
    record.idleTimer = setTimeout(() => {
      void this.stop(record.canvasId);
    }, this.idleStopMs);
  }

  /** Stops every known host (app shutdown). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.hosts.keys()].map((id) => this.stop(id)));
  }
}
