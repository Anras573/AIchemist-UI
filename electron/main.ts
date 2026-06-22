import { app, BrowserWindow } from "electron";
import * as path from "path";
import * as CH from "./ipc-channels";
import { loadEnv, checkApiKeys } from "./config";
import { openDb } from "./db";
import { recoverStaleSessionStatuses } from "./sessions";
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
import { WorkflowScheduler } from "./agent/workflow-scheduler";
import { TrayController } from "./tray";

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

// The workflow cron scheduler. Created in whenReady (it needs the same
// activeTurns / window machinery the handlers use) and armed after handlers
// register. Module-level so before-quit can stop its jobs.
let workflowScheduler: WorkflowScheduler | null = null;

// Optional menu-bar/system-tray icon. Present only while ≥1 enabled scheduled
// workflow is armed — that is exactly when the app survives window close, so the
// tray is the user's handle on the otherwise windowless process.
let tray: TrayController | null = null;

function registerAllHandlers(scheduler: WorkflowScheduler): void {
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
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const stale = recoverStaleSessionStatuses(db);
  if (stale > 0) {
    console.log(`[startup] Marked ${stale} stale session(s) as "error" (were "running" at last exit)`);
  }

  workflowScheduler = new WorkflowScheduler({ db, activeTurns, getMainWindow });
  registerAllHandlers(workflowScheduler);
  const win = createWindow();

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
  // Otherwise survive window close *only* while the scheduler has armed jobs, so
  // those cron workflows keep firing in the background (the tray provides the
  // reopen/quit controls). With no scheduled work, quit as before.
  if (workflowScheduler && workflowScheduler.armedCount > 0) return;
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  cleanupTerminals?.();
  tray?.destroy();
  workflowScheduler?.stopAll();

  // Gracefully shut down all registered providers that implement stop()
  for (const name of getProviderNames()) {
    try {
      void getProvider(name).stop?.();
    } catch {
      // Provider shutdown is best-effort; ignore
    }
  }
});
