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
import { registerGitHubHandlers } from "./ipc/github-handlers";
import { registerMcpHandlers } from "./ipc/mcp-handlers";

// ── Prevent multiple instances ───────────────────────────────────────────────
if (require("electron-squirrel-startup")) app.quit();

// ── Startup: load env + open DB ──────────────────────────────────────────────
loadEnv();
const db = openDb();

let mainWin: BrowserWindow | null = null;

// Sessions that currently have an agent turn in progress.
// Prevents concurrent turns on the same session (e.g. rapid double-send).
const activeTurns = new Set<string>();

export function getMainWindow(): BrowserWindow | null {
  return mainWin;
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

function registerAllHandlers(): void {
  cleanupTerminals = registerTerminalHandlers(() => mainWin);
  registerSettingsHandlers(db);
  registerTraceHandlers(db, () => mainWin);
  registerProjectHandlers(db);
  registerSessionHandlers(db, activeTurns, () => mainWin);
  registerFsHandlers();
  registerAgentHandlers(db, activeTurns, () => mainWin);
  registerGitHubHandlers();
  registerMcpHandlers();
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const stale = recoverStaleSessionStatuses(db);
  if (stale > 0) {
    console.log(`[startup] Marked ${stale} stale session(s) as "error" (were "running" at last exit)`);
  }

  registerAllHandlers();
  const win = createWindow();

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
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  cleanupTerminals?.();

  // Gracefully shut down all registered providers that implement stop()
  for (const name of getProviderNames()) {
    try {
      void getProvider(name).stop?.();
    } catch {
      // Provider shutdown is best-effort; ignore
    }
  }
});
