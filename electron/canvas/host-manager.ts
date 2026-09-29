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
import * as fs from "node:fs";
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

/**
 * Added on top of a tool's own timeout (its `timeoutMs`, or the host's
 * 60s default) when computing the manager-side safety net in `callTool()` —
 * without it, the manager's timer usually races the host's own and fires
 * first, masking the host's real timeout error with a generic one.
 */
export const TOOL_CALL_TIMEOUT_GRACE_MS = 5_000;

/**
 * Debounce window for a running host's dev-reload watcher (#226) — coalesces
 * a burst of `fs.watch` events (a save, a build, an editor's atomic-rename
 * write) into a single restart, same rationale as the workflow scheduler's
 * `FILE_WATCH_DEBOUNCE_MS`.
 */
export const CANVAS_DEV_RELOAD_DEBOUNCE_MS = 500;

/** Default budget for `devReloadLoopMaxCount` / `devReloadLoopWindowMs` — see `CanvasHostManagerOptions`. */
export const DEFAULT_DEV_RELOAD_LOOP_MAX_COUNT = 10;
export const DEFAULT_DEV_RELOAD_LOOP_WINDOW_MS = 30_000;

/** Test seam mirrors `FileWatchFactory` in `workflow-scheduler.ts` — lets tests inject a fake `fs.watch`. */
export type CanvasFileWatchListener = (eventType: fs.WatchEventType, filename: string | Buffer | null) => void;
export type CanvasFileWatchFactory = (
  watchPath: string,
  options: fs.WatchOptions,
  listener: CanvasFileWatchListener
) => fs.FSWatcher;

/**
 * Dev reload only cares about source changes — the files an editor would
 * touch (`server.mjs`, `canvas.json`, anything under `ui/`) — not data a
 * canvas's own server writes into its folder at runtime (a SQLite file for a
 * DB-browser canvas, a cache, a log, or a `node_modules/` from a future
 * `bun install`). The whole folder is watched recursively, so every write is
 * an `fs.watch` event; without this filter, a canvas that writes next to
 * itself on startup restarts itself forever (found in review on #237: 20
 * spawns / 19 reloads in 3s from a canvas writing a cache file on boot).
 * This is the first line of defense; `reloadForDevChange`'s restart-loop
 * budget is the second, for whatever a filename-based filter can't catch.
 */
const DEV_RELOAD_IGNORED_PATH_SEGMENTS = new Set(["node_modules", ".git"]);
const DEV_RELOAD_SOURCE_EXTENSIONS = new Set([".mjs", ".js", ".cjs", ".ts", ".json", ".html", ".css"]);

export function isDevReloadSourceChange(filename: string | Buffer | null): boolean {
  // Some platforms don't report a filename for a recursive watch — err
  // toward reloading rather than silently going deaf to real edits.
  if (filename == null) return true;
  const name = typeof filename === "string" ? filename : filename.toString("utf8");
  const segments = name.split(nodePath.sep);
  if (segments.some((seg) => seg.startsWith(".") || DEV_RELOAD_IGNORED_PATH_SEGMENTS.has(seg))) return false;
  return DEV_RELOAD_SOURCE_EXTENSIONS.has(nodePath.extname(name).toLowerCase());
}

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
 * `"untrusted"` (#227) is what a spawn attempt lands on when
 * `StartCanvasHostOptions.resolveServerPath` returns `null` — a project-tier
 * definition whose trust was revoked, or whose content changed, since the
 * host last (re)started; not a crash, so it never touches the crash-backoff
 * budget, and like `"crashed"`/`"errored"` there is no live process behind it
 * to kill.
 */
export type CanvasHostStatus = "starting" | "running" | "stopped" | "crashed" | "errored" | "untrusted";

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
  /**
   * A running host's definition folder changed on disk and the host was
   * restarted for it (dev reload, #226). Fired after the restart completes
   * (so `onStatusChanged` has already reported the new "running" status) —
   * this is the signal the UI needs on top of that to force the sandboxed
   * iframe to re-navigate and pick up an edited `ui/` file, which a plain
   * status change wouldn't do on its own.
   */
  onDevReload?(canvasId: string): void;
}

export interface StartCanvasHostOptions {
  /** Absolute path to the definition's `server.mjs`, as resolved (and, for a project-tier definition, trust-checked) at the time `start()`/`restart()` was called. */
  serverPath: string;
  projectId: string;
  projectPath: string;
  /**
   * Re-resolves the server path immediately before every spawn this manager
   * performs on its own — a crash auto-restart, or a dev-reload restart
   * (#226) — not just the caller's initial `start()`/`restart()` call, which
   * the caller already gated however it wanted before ever calling this
   * manager. Returns the current path, or `null` if it should no longer be
   * spawned (definition missing, or — the reason this exists — a
   * project-tier definition (#227) that is no longer trusted). Optional and
   * purely additive: when omitted, `spawnHost` just reuses `serverPath`
   * as-is on every respawn, exactly as before this option existed — no
   * caller is required to supply it, but production callers
   * (`canvas-handlers.ts`, `mcp-endpoint.ts`) always do, since without it a
   * revoked or edited project canvas would keep respawning with code nobody
   * re-approved (#227 review on PR #238).
   */
  resolveServerPath?: () => string | null;
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
  /** Manager-side safety net for a call to a tool name the host never declared. */
  toolCallTimeoutMs?: number;
  /** Debounce window for a running host's dev-reload watcher. Default `CANVAS_DEV_RELOAD_DEBOUNCE_MS`. */
  devReloadDebounceMs?: number;
  /** Test seam: inject a fake `fs.watch` for the dev-reload watcher. */
  watchDefinitionDir?: CanvasFileWatchFactory;
  /**
   * Dev-reload restart loop detection — deliberately its own budget,
   * separate from `maxRestarts`/`restartWindowMs` (the crash budget): a
   * human or agent iterating on a canvas's files at a normal pace (a few
   * saves a minute) must never eat into, or get caught by, the crash budget
   * meant for genuine unexpected exits (found in review on #237). More than
   * `devReloadLoopMaxCount` dev-reload-triggered restarts within
   * `devReloadLoopWindowMs` stops the host and marks it `"errored"` instead
   * of restarting forever. Default 10 within 30 s — generous enough that
   * ordinary editing (or an agent writing a few files in one turn) never
   * trips it, while a self-write loop (which cycles roughly every debounce +
   * startup interval) still hits it within seconds.
   */
  devReloadLoopMaxCount?: number;
  /** Sliding window `devReloadLoopMaxCount` is measured over. Default 30 s. */
  devReloadLoopWindowMs?: number;
}

export class CanvasHostTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasHostTimeoutError";
  }
}

/**
 * Distinguishes a genuine tool-level failure (the host is fine; the tool
 * itself said no — bad input, a handler's own thrown error, an unknown tool
 * name) from every other way `callTool()` can reject (host not running, the
 * manager's timeout, the host exiting mid-call). Callers — the canvas MCP
 * endpoint (#223) — use this to surface the tool's own message to the model
 * instead of a generic "canvas unavailable", which would hide it.
 */
export class CanvasToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanvasToolError";
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
  /** Whether this spawn is a backoff-scheduled restart after a crash, vs. a fresh `start()` — read by `failStart()` so a restart attempt that itself fails to become ready still counts against the crash budget instead of quietly landing on `"stopped"`. */
  isRestartAttempt: boolean;
  stopWaiters: Array<() => void>;
  readyWaiters: ReadyWaiter[];
  /** Armed once the host reaches "running" (see the `"ready"` case); watches the definition folder for dev reload. */
  devReloadWatcher: fs.FSWatcher | null;
  devReloadDebounceTimer: ReturnType<typeof setTimeout> | null;
  /** Dev-reload's own loop-detection budget — separate from `restartTimestamps` (the crash budget). See `CanvasHostManagerOptions.devReloadLoopMaxCount`. */
  devReloadTimestamps: number[];
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
  private readonly devReloadDebounceMs: number;
  private readonly watchDefinitionDir: CanvasFileWatchFactory;
  private readonly devReloadLoopMaxCount: number;
  private readonly devReloadLoopWindowMs: number;

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
    this.devReloadDebounceMs = options?.devReloadDebounceMs ?? CANVAS_DEV_RELOAD_DEBOUNCE_MS;
    this.watchDefinitionDir = options?.watchDefinitionDir ?? fs.watch;
    this.devReloadLoopMaxCount = options?.devReloadLoopMaxCount ?? DEFAULT_DEV_RELOAD_LOOP_MAX_COUNT;
    this.devReloadLoopWindowMs = options?.devReloadLoopWindowMs ?? DEFAULT_DEV_RELOAD_LOOP_WINDOW_MS;
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

  /** No-ops when the status isn't actually changing, so consumers never see a duplicate notification. */
  private setStatus(record: HostRecord, status: CanvasHostStatus): void {
    if (record.status === status) return;
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
    revision: number,
    spawnOpts?: { isRestartAttempt?: boolean }
  ): Promise<void> {
    const prior = this.hosts.get(canvasId);

    // Re-verify (via the caller-supplied callback, if any) immediately
    // before actually spawning — the one check that makes this respawn-safe
    // rather than just start-safe (#227 review on PR #238): a crash
    // auto-restart or a dev-reload restart calls this method directly, with
    // no caller in the loop to have gated it. Falls back to the resolved
    // `opts.serverPath` when no callback was given (existing callers/tests
    // that never needed trust gating are unaffected).
    const resolvedServerPath = opts.resolveServerPath ? opts.resolveServerPath() : opts.serverPath;
    if (!resolvedServerPath) {
      return this.refuseUntrustedSpawn(canvasId, prior);
    }
    const effectiveOpts: StartCanvasHostOptions = { ...opts, serverPath: resolvedServerPath };

    const childProcess = this.spawn({
      modulePath: this.entryPath,
      args: [effectiveOpts.serverPath, JSON.stringify({ id: effectiveOpts.projectId, path: effectiveOpts.projectPath })],
      cwd: effectiveOpts.projectPath,
      env: buildHostEnv(process.env),
    });

    const record: HostRecord = {
      canvasId,
      process: childProcess,
      startOpts: effectiveOpts,
      status: "starting",
      tools: [],
      pendingCalls: new Map(),
      // Carried over (not reset) across a crash restart — the renderer only
      // calls setPanelOpen/setTurnActive on a *change*, so a restart that
      // forgot these would let the idle timer stop a host whose panel is
      // still open or whose turn is still running.
      panelOpen: prior?.panelOpen ?? false,
      turnActive: prior?.turnActive ?? false,
      idleTimer: null,
      restartTimer: null,
      startTimer: null,
      restartTimestamps: prior?.restartTimestamps ?? [],
      stopping: false,
      isRestartAttempt: spawnOpts?.isRestartAttempt ?? false,
      stopWaiters: [],
      readyWaiters: [],
      devReloadWatcher: null,
      devReloadDebounceTimer: null,
      devReloadTimestamps: prior?.devReloadTimestamps ?? [],
    };
    this.hosts.set(canvasId, record);
    this.callHook("onStatusChanged", canvasId, "starting");

    const readyPromise = new Promise<void>((resolve, reject) => {
      record.readyWaiters.push({ resolve, reject });
    });

    record.startTimer = setTimeout(() => {
      this.failStart(
        record,
        new CanvasHostTimeoutError(`Canvas host did not become ready within ${this.startTimeoutMs}ms`)
      );
    }, this.startTimeoutMs);

    childProcess.on("message", (raw) => this.handleMessage(record, raw));
    childProcess.on("exit", (code) => this.handleExit(record, code));

    childProcess.postMessage({ type: "init", state, revision });

    return readyPromise;
  }

  /**
   * Handles a spawn attempt `resolveServerPath` refused (#227): no child
   * process is ever created. When a `prior` record exists (the respawn
   * cases this exists for — its old process has, by construction, already
   * fully exited by the time `spawnHost` runs again: `stop()` already
   * resolved before a dev-reload restart's `start()`, and `handleExit`
   * already ran before a crash restart's timer fires), it's transitioned in
   * place to `"untrusted"` rather than left on its last status, and its
   * timers disarmed since nothing is going to run for it. When there's no
   * prior record at all (a bare first `start()` call whose caller — unlike
   * every production caller — didn't already gate this itself), nothing is
   * added to `this.hosts`; `getStatus()` for it simply reads as `undefined`,
   * same as a canvas that was never started.
   */
  private refuseUntrustedSpawn(canvasId: string, prior: HostRecord | undefined): Promise<void> {
    const err = new Error("Canvas host cannot start: the definition is unavailable or no longer trusted");
    console.error(`[canvas-host-manager] refusing to (re)spawn ${canvasId}: ${err.message}`);
    if (prior) {
      this.disarmDevReload(prior);
      if (prior.restartTimer) {
        clearTimeout(prior.restartTimer);
        prior.restartTimer = null;
      }
      if (prior.idleTimer) {
        clearTimeout(prior.idleTimer);
        prior.idleTimer = null;
      }
      this.setStatus(prior, "untrusted");
      this.rejectReadyWaiters(prior, err);
    }
    return Promise.reject(err);
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

  /**
   * Terminates a start attempt that failed before reaching `"running"` (start
   * timeout, or an `init.error` message) — rejects whoever's waiting on
   * `start()`, kills the (never-ready) process, and moves the record out of
   * `"starting"` so it isn't stuck forever: without this, the next `start()`
   * call would see `"starting"`, push a new waiter with no timer of its own,
   * and hang, while the failed process kept running untracked.
   *
   * When this attempt was itself a backoff-scheduled restart
   * (`record.isRestartAttempt`), the failure counts against the crash budget
   * via `recordCrashAndScheduleRestart` instead of landing on a plain
   * `"stopped"` — otherwise a canvas whose `server.mjs` starts throwing on
   * import right after a crash would sit quietly "stopped" rather than ever
   * reaching `"errored"`.
   */
  private failStart(record: HostRecord, err: Error): void {
    this.disarmDevReload(record);
    record.stopping = true;
    this.rejectReadyWaiters(record, err);
    if (record.isRestartAttempt) {
      this.recordCrashAndScheduleRestart(record);
    } else {
      this.setStatus(record, "stopped");
    }
    try {
      record.process.kill();
    } catch (killErr) {
      console.error(`[canvas-host-manager] failed to kill unready host ${record.canvasId}:`, killErr);
    }
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
        this.armDevReload(record);
        break;
      case "init.error":
        console.error(`[canvas-host-manager] host ${record.canvasId} failed to initialize:`, msg.error);
        this.failStart(record, new Error(msg.error));
        break;
      case "tool.result": {
        const pending = record.pendingCalls.get(msg.callId);
        if (!pending) break;
        clearTimeout(pending.timer);
        record.pendingCalls.delete(msg.callId);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new CanvasToolError(msg.error?.message ?? "Canvas tool call failed"));
        break;
      }
      case "state.changed": {
        // A canvas can trigger this by writing state past the store's 1MB cap,
        // or by writing after its row was deleted out from under it — neither
        // is allowed to reach main as an uncaught exception. The host's local
        // state/revision can drift from the DB when this happens (tracked as
        // a follow-up: https://github.com/Anras573/AIchemist-UI/issues/233 —
        // the host has no ack path yet to reject `ctx.state.set` when the
        // persist fails), so this is a backstop, not a full fix. Emitting the
        // *store's* returned state/revision here (rather than the host's own
        // `msg.state`/`msg.revision`) at least keeps every consumer of this
        // hook — including the eventual UI sync — seeing only the DB's
        // authoritative value instead of drifting right along with the host.
        let saved;
        try {
          saved = setCanvasState(this.db, record.canvasId, msg.state);
        } catch (err) {
          console.error(`[canvas-host-manager] failed to persist state for ${record.canvasId}:`, err);
          break;
        }
        this.callHook("onStateChanged", record.canvasId, saved.state, saved.revision);
        break;
      }
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
    this.disarmDevReload(record);
    if (record.idleTimer) clearTimeout(record.idleTimer);

    for (const pending of record.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Canvas host exited before replying"));
    }
    record.pendingCalls.clear();

    if (record.stopping) {
      // A restart attempt that itself failed (`failStart` with
      // `isRestartAttempt`) has already driven this record to "crashed" or
      // "errored" via `recordCrashAndScheduleRestart` before killing the
      // process — don't let this (possibly later-arriving, and by now
      // irrelevant) exit downgrade that decision back to a plain "stopped".
      if (record.status !== "crashed" && record.status !== "errored") {
        this.setStatus(record, "stopped");
      }
      this.rejectReadyWaiters(record, new Error("Canvas host was stopped"));
      const waiters = record.stopWaiters;
      record.stopWaiters = [];
      for (const resolve of waiters) resolve();
      return;
    }

    this.rejectReadyWaiters(record, new Error("Canvas host exited before becoming ready"));
    this.recordCrashAndScheduleRestart(record);
  }

  /**
   * Records a crash — an unexpected exit, or a restart attempt that itself
   * failed to become ready — against the backoff budget: schedules the next
   * attempt ("crashed") or gives up ("errored") once `maxRestarts` is spent
   * within `restartWindowMs`. Shared by `handleExit` (a running host died)
   * and `failStart` (a backoff-scheduled restart's own start attempt failed,
   * which must still count against the budget rather than quietly landing on
   * `"stopped"`).
   */
  private recordCrashAndScheduleRestart(record: HostRecord): void {
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
      this.spawnHost(record.canvasId, record.startOpts, canvas.state, canvas.revision, {
        isRestartAttempt: true,
      }).catch((err: unknown) => {
        console.error(`[canvas-host-manager] restart of ${record.canvasId} failed:`, err);
      });
    }, delayMs);
  }

  /**
   * Sends a tool call to a running host and resolves with its result (or
   * rejects with the tool's error). Rejects immediately if the host isn't
   * running. Otherwise settles no later than `opts.timeoutMs` (default: the
   * tool's own `timeoutMs`, or the host's 60s default, plus a grace margin) —
   * but the host is only ever killed once that grace-padded *tool budget*
   * has elapsed, regardless of a shorter `opts.timeoutMs`: a caller-supplied
   * override controls only how soon this one call gives up waiting, never
   * whether the host itself gets treated as hung. Without that split, an
   * aggressive caller timeout on a legitimately slow tool would kill a
   * perfectly healthy host and spend a crash from its restart budget.
   */
  callTool(canvasId: string, tool: string, args: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
    const record = this.hosts.get(canvasId);
    if (!record || record.status !== "running") {
      return Promise.reject(new Error(`Canvas host is not running: ${canvasId}`));
    }

    const callId = crypto.randomUUID();
    // Sized off the tool's own timeout (as reported at `ready`) plus a grace
    // margin, so this safety net only fires when the host is truly
    // unresponsive — never racing (and masking) the host's own per-tool
    // timeout error. Falls back to `toolCallTimeoutMs` for a tool name the
    // host never declared (e.g. a typo'd call, which errors back quickly).
    const descriptor = record.tools.find((t) => t.name === tool);
    const toolBudgetMs = descriptor
      ? (descriptor.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS) + TOOL_CALL_TIMEOUT_GRACE_MS
      : this.toolCallTimeoutMs;
    const timeoutMs = opts?.timeoutMs ?? toolBudgetMs;

    return new Promise((resolve, reject) => {
      // Settles THIS call's promise at the caller's requested timeout. Never
      // touches `pendingCalls` or the process directly — when `timeoutMs` is
      // shorter than `toolBudgetMs`, the call below still needs to observe
      // whatever the host does with this callId afterward.
      setTimeout(() => {
        reject(new CanvasHostTimeoutError(`Canvas host did not reply to tool "${tool}" within ${timeoutMs}ms`));
      }, timeoutMs);

      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return; // the host replied, or the process already exited, before its real budget elapsed
        record.pendingCalls.delete(callId);
        // This fired after the tool's own timeout plus a grace margin, so the
        // host's event loop is genuinely stuck (its own per-tool timer would
        // otherwise have answered by now) — recover it like any other crash
        // instead of leaving a permanently wedged process marked "running"
        // that would time out every future call the same way. Not a deliberate
        // `stop()` (no `record.stopping`), so `handleExit` routes this through
        // the normal backoff → "errored" path, per #222's acceptance criteria.
        try {
          record.process.kill();
        } catch (killErr) {
          console.error(`[canvas-host-manager] failed to kill unresponsive host ${canvasId}:`, killErr);
        }
      }, toolBudgetMs);

      record.pendingCalls.set(callId, {
        resolve: (result) => {
          settled = true;
          resolve(result);
        },
        reject: (err) => {
          settled = true;
          reject(err);
        },
        timer,
      });
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
    this.disarmDevReload(record);
    if (record.restartTimer) {
      clearTimeout(record.restartTimer);
      record.restartTimer = null;
    }
    if (record.idleTimer) {
      clearTimeout(record.idleTimer);
      record.idleTimer = null;
    }

    // A "crashed" or "errored" host's process has already exited — handleExit
    // already ran once and won't run again for it, so kill()ing it again would
    // never produce a second "exit" event to resolve on. Clean up directly
    // instead of waiting on one, or restart() (the only way out of "errored")
    // and stopAll() at app quit would hang forever. Same story for
    // "untrusted" (#227): `refuseUntrustedSpawn` never spawned a process for
    // this attempt, and the record's process reference (if any) is whatever
    // was already fully exited before that refusal — there is nothing left
    // to kill either way.
    if (record.status === "crashed" || record.status === "errored" || record.status === "untrusted") {
      record.stopping = true;
      this.setStatus(record, "stopped");
      return Promise.resolve();
    }

    record.stopping = true;
    const stopped = new Promise<void>((resolve) => record.stopWaiters.push(resolve));
    record.process.kill();
    return stopped;
  }

  /** Stops and restarts a host, resetting both the crash-backoff and dev-reload-loop budgets — an explicit user "Restart" deserves a clean slate. */
  async restart(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    await this.restartInternal(canvasId, opts, { resetBackoff: true });
  }

  /**
   * Shared by the public `restart()` (resets both budgets) and
   * `reloadForDevChange` (doesn't — a dev-reload restart manages its own
   * `devReloadTimestamps` budget separately, see `reloadForDevChange`).
   */
  private async restartInternal(
    canvasId: string,
    opts: StartCanvasHostOptions,
    options: { resetBackoff: boolean }
  ): Promise<void> {
    await this.stop(canvasId);
    const record = this.hosts.get(canvasId);
    if (record && options.resetBackoff) {
      record.restartTimestamps = [];
      record.devReloadTimestamps = [];
    }
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

  // ── Dev reload (#226) ────────────────────────────────────────────────────

  /**
   * Watches a just-started host's definition folder (`server.mjs` + `ui/`,
   * both under the same directory) so editing either while the host runs
   * reloads it without an app restart. Armed once per `"ready"` — a restart
   * (dev-triggered or manual) tears the watcher down via `stop()` and
   * `armDevReload` re-arms it on the next `"ready"`, so it stays live across
   * restarts without any extra bookkeeping. Fail-safe, same stance as the
   * workflow scheduler's file watch: an unwatchable directory is logged and
   * skipped rather than failing the host start it's piggybacking on.
   */
  private armDevReload(record: HostRecord): void {
    const dir = nodePath.dirname(record.startOpts.serverPath);
    try {
      const watcher = this.watchDefinitionDir(dir, { recursive: true }, (_eventType, filename) => {
        if (!isDevReloadSourceChange(filename)) return;
        this.scheduleDevReload(record);
      });
      watcher.on("error", (err) => {
        console.error(`[canvas-host-manager] dev-reload watcher error for ${record.canvasId} ("${dir}"):`, err);
        this.disarmDevReload(record);
      });
      record.devReloadWatcher = watcher;
    } catch (err) {
      console.error(`[canvas-host-manager] failed to watch "${dir}" for dev reload (${record.canvasId}):`, err);
    }
  }

  /** Stops and forgets a host's dev-reload watcher (clearing any pending debounce). Idempotent. */
  private disarmDevReload(record: HostRecord): void {
    if (record.devReloadDebounceTimer) {
      clearTimeout(record.devReloadDebounceTimer);
      record.devReloadDebounceTimer = null;
    }
    if (record.devReloadWatcher) {
      try {
        record.devReloadWatcher.close();
      } catch {
        // Closing an already-errored watcher can throw; it's being forgotten
        // regardless, so swallow (mirrors the workflow scheduler's watcher).
      }
      record.devReloadWatcher = null;
    }
  }

  /**
   * Coalesces a burst of file events (a save, a build, an editor's
   * atomic-rename write) into a single restart, same debounce shape as the
   * workflow scheduler's file trigger.
   */
  private scheduleDevReload(record: HostRecord): void {
    if (record.devReloadDebounceTimer) clearTimeout(record.devReloadDebounceTimer);
    record.devReloadDebounceTimer = setTimeout(() => {
      record.devReloadDebounceTimer = null;
      void this.reloadForDevChange(record.canvasId, record.startOpts);
    }, this.devReloadDebounceMs);
  }

  /**
   * Restarts the host and, once that succeeds, fires `onDevReload` so the UI
   * can force its sandboxed iframe to re-navigate — a plain host restart
   * doesn't affect the already-loaded UI on its own (a `server.mjs`-only
   * change wouldn't need it, but a `ui/` change does, and debouncing folds
   * both into the same folder watch, so every dev-reload restart reports it).
   *
   * Uses its own loop budget (`record.devReloadTimestamps`,
   * `devReloadLoopMaxCount` / `devReloadLoopWindowMs`) — deliberately
   * **not** the crash budget (`restartTimestamps`/`maxRestarts`). An earlier
   * version shared the crash budget as a second line of defense against
   * whatever `isDevReloadSourceChange` doesn't filter out, but that meant a
   * few ordinary saves (or an agent turn writing a handful of files) could
   * exhaust a *human's* editing budget and pre-spend a *crash's* backoff
   * budget too — a regression found in review on #237. The two are
   * unrelated concerns: this budget is generous (default 10 within 30s)
   * because it only needs to catch something cycling far faster than any
   * person or turn would — a self-write loop restarts roughly every
   * debounce + startup interval, so it blows through 10 in a few seconds —
   * while never touching what the crash path uses to judge a real exit.
   */
  private async reloadForDevChange(canvasId: string, opts: StartCanvasHostOptions): Promise<void> {
    const record = this.hosts.get(canvasId);
    if (!record) return; // host was stopped/removed between the debounce firing and now

    const now = Date.now();
    record.devReloadTimestamps = record.devReloadTimestamps.filter((t) => now - t < this.devReloadLoopWindowMs);
    record.devReloadTimestamps.push(now);
    if (record.devReloadTimestamps.length > this.devReloadLoopMaxCount) {
      this.stopDevReloadLoop(record, canvasId);
      return;
    }

    try {
      await this.restartInternal(canvasId, opts, { resetBackoff: false });
      this.callHook("onDevReload", canvasId);
    } catch (err) {
      console.error(`[canvas-host-manager] dev-reload restart failed for ${canvasId}:`, err);
    }
  }

  /**
   * Terminal state for a dev-reload restart loop that exceeded its own
   * budget: disarms the watcher (a hands-off host has no reason to keep
   * watching) and kills the process, setting `"errored"` before the kill so
   * `handleExit` — which still fires — doesn't downgrade it back to
   * `"stopped"` (same ordering `failStart` uses for the same reason). A
   * manual `restart()` is the only way out, and it resets both budgets.
   */
  private stopDevReloadLoop(record: HostRecord, canvasId: string): void {
    console.error(
      `[canvas-host-manager] dev-reload restart loop detected for ${canvasId} ` +
        `(more than ${this.devReloadLoopMaxCount} dev-reload restarts within ${this.devReloadLoopWindowMs}ms) — ` +
        `stopping instead of restarting forever. Check whether the canvas's server writes files into its own definition folder.`
    );
    this.disarmDevReload(record);
    record.stopping = true;
    this.setStatus(record, "errored");
    try {
      record.process.kill();
    } catch (killErr) {
      console.error(`[canvas-host-manager] failed to kill looping host ${canvasId}:`, killErr);
    }
  }
}
