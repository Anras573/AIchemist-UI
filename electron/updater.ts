import { app, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import * as CH from "./ipc-channels";
import type { UpdateStatus } from "../src/types";

autoUpdater.autoDownload = true;
// Installs silently on the next natural quit if the user never clicked
// "Restart & update" — matches the default behavior of most auto-updating
// desktop apps (VS Code, Slack, …).
autoUpdater.autoInstallOnAppQuit = true;

let latestStatus: UpdateStatus = { state: "idle" };
let getWindow: (() => BrowserWindow | null) | null = null;

function emit(status: UpdateStatus): void {
  latestStatus = status;
  getWindow?.()?.webContents.send(CH.UPDATE_STATUS, status);
}

/** Last known update status — used by UPDATE_GET_STATE so a late-mounted UI can render the current state without waiting for the next push event. */
export function getUpdateStatus(): UpdateStatus {
  return latestStatus;
}

/** Wires autoUpdater's events to UPDATE_STATUS push events. Call once at startup. */
export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  getWindow = getMainWindow;

  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-available", (info) => emit({ state: "available", version: info.version }));
  autoUpdater.on("update-not-available", () => emit({ state: "not-available" }));
  autoUpdater.on("download-progress", (progress) =>
    emit({ state: "downloading", percent: Math.round(progress.percent) })
  );
  autoUpdater.on("update-downloaded", (info) => emit({ state: "downloaded", version: info.version }));
  autoUpdater.on("error", (err) => emit({ state: "error", error: err.message }));
}

/**
 * Checks for an update (and auto-downloads one if found). A no-op outside a
 * packaged build — electron-updater requires app-update.yml, which only
 * exists in a built app, and would otherwise throw in `bun run dev`.
 */
export async function checkForUpdates(): Promise<void> {
  if (!app.isPackaged) {
    emit({ state: "not-available" });
    return;
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    emit({ state: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

/** Quits and installs the downloaded update. Only meaningful once `state === "downloaded"`. */
export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}
