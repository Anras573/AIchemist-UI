import { app, BrowserWindow } from "electron";
import * as path from "path";
import * as CH from "./ipc-channels";
import { loadEnv, checkApiKeys } from "./config";
import { openDb } from "./db";
import { recoverStaleSessionStatuses } from "./sessions";
import { backfillUsageLedger } from "./usage-backfill";
import { getProvider, getProviderNames } from "./agent/runner";

import { registerTerminalHandlers } from "./ipc/terminal-handlers";
import { registerSettingsHandlers } from "./ipc/settings-handlers";
import { registerTraceHandlers } from "./ipc/trace-handlers";
import { registerProjectHandlers } from "./ipc/project-handlers";
import { registerSessionHandlers } from "./ipc/session-handlers";
import { registerFsHandlers } from "./ipc/fs-handlers";
import { registerAgentHandlers } from "./ipc/agent-handlers";
import { registerLibraryHandlers } from "./ipc/library-handlers";
import { registerGitHubHandlers } from "./ipc/github-handlers";
import { registerMcpHandlers } from "./ipc/mcp-handlers";
import { registerWorkflowHandlers } from "./ipc/workflow-handlers";
import { registerCanvasHandlers } from "./ipc/canvas-handlers";
import { registerBudgetHandlers } from "./ipc/budget-handlers";
import { registerSpendingHandlers } from "./ipc/spending-handlers";
import { registerUpdateHandlers } from "./ipc/update-handlers";
import { WorkflowScheduler } from "./agent/workflow-scheduler";
import { CanvasHostManager } from "./canvas/host-manager";
import { CanvasMcpEndpoint, setActiveCanvasMcpEndpoint } from "./canvas/mcp-endpoint";
import { registerCanvasProtocol, registerCanvasProtocolScheme } from "./canvas/protocol";
import { TrayController } from "./tray";
import { initAutoUpdater, checkForUpdates } from "./updater";

// Must run before app.whenReady() — Electron requires privileged-scheme
// registration to happen before the app is ready.
registerCanvasProtocolScheme();

// How often to silently check for a new release in the background, on top of
// the one-shot check shortly after startup. electron-updater auto-downloads
// and (with autoInstallOnAppQuit) installs on the next natural quit — no
// restart is forced.
const UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 hours

// ── Prevent multiple instances ───────────────────────────────────────────────
if (require("electron-squirrel-startup")) app.quit();

// ── Startup: load env + open DB ──────────────────────────────────────────────
loadEnv();
const db = openDb();

let mainWin: BrowserWindow | null = null;

// Set once the user (or the system) has asked for a real quit. Distinguishes a
// genuine quit from a plain window close: when scheduled workflows are armed we
// keep the app alive on window-all-closed (tray-only) instead of quitting, but
// an explicit quit must still go through.
let isQuitting = false;

// Sessions that currently have an agent turn in progress.
// Prevents concurrent turns on the same session (e.g. rapid double-send).
const activeTurns = new Set<string>();

export function getMainWindow(): BrowserWindow | null {
  return mainWin;
}

/** Focus the existing window, recreating it if it was closed (tray "Open"). */
function showWindow(): void {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  } else {
    createWindow();
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Explicit even though it's Electron's default — a canvas UI's
      // isolation (aichemist-canvas:// + sandboxed iframe, see CanvasFrame)
      // depends on there being no other way to load privileged content.
      webviewTag: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWin = win;
  win.on("closed", () => { mainWin = null; });
  return win;
}

let cleanupTerminals: (() => void) | undefined;
let updateCheckTimer: NodeJS.Timeout | undefined;
let updateCheckInterval: NodeJS.Timeout | undefined;

// The workflow cron scheduler. Created in whenReady (it needs the same
// activeTurns / window machinery the handlers use) and armed after handlers
// register. Module-level so before-quit can stop its jobs.
let workflowScheduler: WorkflowScheduler | null = null;

// Canvas host supervisor (#222) + the loopback MCP endpoint that exposes
// attached canvases' tools to every provider (#223), plus the panel-facing
// IPC (#224). All three are created once at startup; the host manager's
// hooks push CANVAS_EVENT (state/message/status/log) to the renderer, and
// the endpoint is torn down on quit so a relaunch gets a fresh per-launch
// bearer token.
let canvasHostManager: CanvasHostManager | null = null;
let canvasMcpEndpoint: CanvasMcpEndpoint | null = null;

// Optional menu-bar/system-tray icon. Present only while ≥1 enabled scheduled
// workflow is armed — that is exactly when the app survives window close, so the
// tray is the user's handle on the otherwise windowless process.
let tray: TrayController | null = null;

function registerAllHandlers(scheduler: WorkflowScheduler, hostManager: CanvasHostManager): void {
  cleanupTerminals = registerTerminalHandlers(() => mainWin);
  registerSettingsHandlers(db);
  registerTraceHandlers(db, () => mainWin);
  registerProjectHandlers(db);
  registerSessionHandlers(db, activeTurns, () => mainWin);
  registerFsHandlers();
  registerAgentHandlers(db, activeTurns, () => mainWin);
  registerLibraryHandlers(db);
  registerGitHubHandlers();
  registerMcpHandlers();
  registerWorkflowHandlers(db, scheduler);
  registerCanvasHandlers(db, hostManager);
  registerBudgetHandlers(db);
  registerSpendingHandlers(db);
  registerUpdateHandlers();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const stale = recoverStaleSessionStatuses(db);
  if (stale > 0) {
    console.log(`[startup] Marked ${stale} stale session(s) as "error" (were "running" at last exit)`);
  }

  // Fire-and-forget: backfills the usage ledger from historical trace
  // transcripts for any session with no ledger rows yet. Idempotent (a
  // session with existing rows is skipped) and fail-safe per session, so it's
  // safe to run unawaited on every startup rather than gating it behind a
  // one-shot flag.
  void backfillUsageLedger(db)
    .then(({ sessions, totalTurnsBackfilled }) => {
      const backfilled = sessions.filter((s) => s.status === "backfilled").length;
      if (backfilled > 0) {
        console.log(
          `[startup] Backfilled usage ledger for ${backfilled} session(s), ${totalTurnsBackfilled} turn(s)`
        );
      }
    })
    .catch((err) => {
      console.error("[startup] Usage ledger backfill failed:", err);
    });

  workflowScheduler = new WorkflowScheduler({ db, activeTurns, getMainWindow });

  // Canvas host supervisor — created before registerAllHandlers() so its
  // hooks (pushing CANVAS_EVENT for a state write, a relayed UI message, a
  // status change, or a debug log line) are wired before any IPC handler
  // can start a host. getMainWindow() is safe to call from a hook even before
  // createWindow() runs below: it just resolves to null until then, and
  // webContents.send() on a null window is a no-op via the optional chain.
  canvasHostManager = new CanvasHostManager(db, {
    hooks: {
      onStateChanged: (canvasId, state, revision) =>
        getMainWindow()?.webContents.send(CH.CANVAS_EVENT, { canvasId, kind: "state", state, revision }),
      onUiMessage: (canvasId, message) =>
        getMainWindow()?.webContents.send(CH.CANVAS_EVENT, { canvasId, kind: "message", message }),
      onStatusChanged: (canvasId, status) =>
        getMainWindow()?.webContents.send(CH.CANVAS_EVENT, { canvasId, kind: "status", status }),
      onLog: (canvasId, level, args) =>
        getMainWindow()?.webContents.send(CH.CANVAS_EVENT, { canvasId, kind: "log", level, args }),
    },
  });
  registerAllHandlers(workflowScheduler, canvasHostManager);
  registerCanvasProtocol(db);

  // Canvas loopback MCP endpoint (#223) — starts before the window so the
  // first turn on any session can already reach it. A failure here must never
  // block app startup: canvases just stay unreachable (tool calls report
  // "canvas unavailable") until the next launch.
  canvasMcpEndpoint = new CanvasMcpEndpoint({ db, hostManager: canvasHostManager, getMainWindow });
  canvasMcpEndpoint
    .start()
    .then(() => setActiveCanvasMcpEndpoint(canvasMcpEndpoint))
    .catch((err: unknown) => {
      console.error("[startup] Canvas MCP endpoint failed to start:", err);
    });

  const win = createWindow();

  // Auto-update: check shortly after launch (once the window can receive the
  // push events) and then periodically in the background. No-op in dev
  // (checkForUpdates() guards on app.isPackaged).
  initAutoUpdater(getMainWindow);
  updateCheckTimer = setTimeout(() => void checkForUpdates(), 10_000);
  updateCheckInterval = setInterval(() => void checkForUpdates(), UPDATE_CHECK_INTERVAL_MS);

  // The tray appears whenever the scheduler has at least one armed job and lets
  // the user reopen the window or quit while it runs in the background.
  const scheduler = workflowScheduler;
  tray = new TrayController({
    showWindow,
    getScheduledCount: () => scheduler.armedCount,
    quit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  // Re-evaluate the tray whenever workflows are armed/disarmed (boot, upsert,
  // delete, enable/disable) so it tracks the live scheduled-workflow count.
  scheduler.onJobsChanged(() => tray?.refresh());

  // Arm enabled cron workflows after handlers register. Forward-only: missed
  // occurrences while the app was closed are not replayed. `start()` fires the
  // jobs-changed listener, which performs the initial tray reconcile.
  workflowScheduler.start();

  // Warn if no API keys are configured — both providers missing means
  // the user won't be able to run any agent turns.
  const missingKeys = checkApiKeys();
  if (missingKeys.length === 2) {
    // Both Anthropic and Copilot keys are absent — emit warning once window loads
    win.webContents.once("did-finish-load", () => {
      win.webContents.send(CH.CONFIG_WARNING, {
        message: `No API keys configured. Add ANTHROPIC_API_KEY or GITHUB_TOKEN to ~/.aichemist/.env to use the agent.`,
        missing: missingKeys,
      });
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // macOS apps conventionally stay alive with no windows; nothing to decide.
  if (process.platform === "darwin") return;
  // An explicit quit (tray "Quit", before-quit already fired) always proceeds.
  if (isQuitting) {
    app.quit();
    return;
  }
  // Otherwise survive window close *only* while the scheduler has armed jobs AND
  // a tray icon actually exists, so those cron workflows keep firing in the
  // background with the tray providing the reopen/quit controls. If the tray
  // failed to create there would be no way to restore/quit a windowless process,
  // so fall back to quitting (as before this feature). No scheduled work → quit.
  if (workflowScheduler && workflowScheduler.armedCount > 0 && tray?.isActive()) return;
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  cleanupTerminals?.();
  clearTimeout(updateCheckTimer);
  clearInterval(updateCheckInterval);
  tray?.destroy();
  workflowScheduler?.stopAll();
  setActiveCanvasMcpEndpoint(null);
  void canvasMcpEndpoint?.stop();
  void canvasHostManager?.stopAll();

  // Gracefully shut down all registered providers that implement stop()
  for (const name of getProviderNames()) {
    try {
      void getProvider(name).stop?.();
    } catch {
      // Provider shutdown is best-effort; ignore
    }
  }
});
