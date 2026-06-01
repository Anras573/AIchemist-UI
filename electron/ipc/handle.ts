import { ipcMain } from "electron";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;

export function handle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IPC] "${channel}" failed:`, err);
      throw new Error(message);
    }
  });
}
