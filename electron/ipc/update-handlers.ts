import { app } from "electron";
import * as CH from "../ipc-channels";
import { checkForUpdates, getUpdateStatus, quitAndInstall } from "../updater";
import { handle } from "./handle";

export function registerUpdateHandlers(): void {
  handle(CH.UPDATE_CHECK, async () => {
    await checkForUpdates();
    return getUpdateStatus();
  });
  handle(CH.UPDATE_INSTALL, () => {
    quitAndInstall();
  });
  handle(CH.UPDATE_GET_STATE, () => ({
    currentVersion: app.getVersion(),
    status: getUpdateStatus(),
  }));
}
