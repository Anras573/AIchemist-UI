/**
 * Pop-out canvas windows (#248): a canvas instance shown in its own
 * `BrowserWindow` instead of the right panel's Canvas tab. The window loads
 * the same renderer bundle with a `?canvasPopout=<id>` query, which `main.tsx`
 * routes to `CanvasPopout` — a bare `CanvasFrame`, so the iframe sandbox,
 * `aichemist-canvas://` CSP and navigation guard are identical to the panel's.
 *
 * Also owns `broadcast()`, which fans `CANVAS_EVENT` pushes out to the main
 * window *and* every pop-out, so each view stays live.
 */
export interface PopoutWindowLike {
  webContents: { id: number; send(channel: string, payload: unknown): void; isDestroyed(): boolean };
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
  on(event: "closed", listener: () => void): unknown;
}

export interface CanvasPopoutMeta {
  title: string;
  definition: string;
}

export interface CanvasPopoutManagerOptions {
  getMainWindow: () => { webContents: { send(channel: string, payload: unknown): void; isDestroyed(): boolean } } | null;
  createWindow: (canvasId: string, meta: CanvasPopoutMeta) => PopoutWindowLike;
  /** Called after a pop-out closes, with its `webContents.id`, so viewer tracking can release it. */
  onClosed?: (webContentsId: number) => void;
}

export class CanvasPopoutManager {
  private readonly windows = new Map<string, PopoutWindowLike>();

  constructor(private readonly opts: CanvasPopoutManagerOptions) {}

  /** Opens the pop-out for an instance, or focuses it if already open. */
  open(canvasId: string, meta: CanvasPopoutMeta): void {
    const existing = this.windows.get(canvasId);
    if (existing && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.focus();
      return;
    }
    const win = this.opts.createWindow(canvasId, meta);
    const webContentsId = win.webContents.id;
    this.windows.set(canvasId, win);
    win.on("closed", () => {
      if (this.windows.get(canvasId) === win) this.windows.delete(canvasId);
      this.opts.onClosed?.(webContentsId);
    });
  }

  isOpen(canvasId: string): boolean {
    const win = this.windows.get(canvasId);
    return !!win && !win.isDestroyed();
  }

  /** Sends to the main window and every live pop-out. */
  broadcast(channel: string, payload: unknown): void {
    const main = this.opts.getMainWindow();
    if (main && !main.webContents.isDestroyed()) main.webContents.send(channel, payload);
    for (const win of this.windows.values()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
    }
  }
}
