import * as crypto from "crypto";
import type { BrowserWindow } from "electron";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import * as CH from "../ipc-channels";
import { buildChildProcessPath } from "../config";
import { handle } from "./handle";

const terminals = new Map<string, IPty>();

export function registerTerminalHandlers(getMainWindow: () => BrowserWindow | null): () => void {
  handle(CH.TERMINAL_CREATE, (_event, projectPath: string) => {
    const id = crypto.randomUUID();
    const isWindows = process.platform === "win32";
    const shell = isWindows
      ? (process.env.COMSPEC ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/bash");
    const env = isWindows
      ? ({ ...process.env } as Record<string, string>)
      : ({ ...process.env, PATH: buildChildProcessPath(process.env.PATH) } as Record<string, string>);

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: projectPath,
      env,
    });

    terminals.set(id, term);

    term.onData((data) => {
      getMainWindow()?.webContents.send(CH.TERMINAL_OUTPUT, { id, data });
    });

    term.onExit(() => {
      terminals.delete(id);
      getMainWindow()?.webContents.send(CH.TERMINAL_OUTPUT, { id, data: "\r\n[Process exited]\r\n" });
    });

    return id;
  });

  handle(CH.TERMINAL_INPUT, (_event, id: string, data: string) => {
    terminals.get(id)?.write(data);
  });

  handle(CH.TERMINAL_RESIZE, (_event, id: string, cols: number, rows: number) => {
    terminals.get(id)?.resize(cols, rows);
  });

  handle(CH.TERMINAL_CLOSE, (_event, id: string) => {
    const term = terminals.get(id);
    if (term) {
      try { term.kill(); } catch { /* already exited */ }
      terminals.delete(id);
    }
  });

  return () => {
    for (const term of terminals.values()) {
      try { term.kill(); } catch { /* already exited */ }
    }
    terminals.clear();
  };
}
