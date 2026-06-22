import { Menu, nativeImage, Tray } from "electron";

// A 32×32 violet Erlenmeyer-flask icon, embedded as a base64 PNG so the tray
// needs no asset-pipeline wiring in the main-process build (electron-vite only
// bundles the entry module — there is no `resources/` copy step). Generated
// once; if the app gains a real icon set, swap this for a file load.
const TRAY_ICON_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAZ0lEQVR4nO3UuwkAIBADUAd1FDdwEDe0sFHsxc/daRASuNa8QuIcw/yW4HOdHQzyrJgAAggYlcM34CkAuoSr8usIKGC3/AritNwcAQX0h1IsojNBQAGacjXColyFgAKkvx460wwjTQP/ZpwTykqFrQAAAABJRU5ErkJggg==";

function trayImage(): Electron.NativeImage {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  // Menu-bar icons are small; 16pt reads correctly on every platform's tray.
  return img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
}

/** What the tray needs from the app to (re)build its menu and act on clicks. */
export interface TrayDeps {
  /** Focus the existing window, or create one if it was closed. */
  showWindow: () => void;
  /** Number of enabled scheduled workflows currently armed. */
  getScheduledCount: () => number;
  /** Begin a real quit (sets the quitting flag, then `app.quit()`). */
  quit: () => void;
}

/**
 * Owns the optional menu-bar / system-tray icon. The icon is only present while
 * at least one enabled scheduled workflow is armed — that is the same condition
 * under which `window-all-closed` keeps the app alive (see `main.ts`), so the
 * tray is the user's only handle on a windowless-but-running app: it lets them
 * reopen the window or quit outright.
 *
 * {@link TrayController.refresh} is idempotent and drives the whole lifecycle:
 * it creates the tray when the scheduled count rises above zero, tears it down
 * when it returns to zero, and otherwise just refreshes the tooltip + menu.
 */
export class TrayController {
  private tray: Tray | null = null;

  constructor(private readonly deps: TrayDeps) {}

  /** Reconcile the tray's existence + contents with the current scheduled count. */
  refresh(): void {
    const count = this.deps.getScheduledCount();
    if (count > 0) {
      if (!this.tray) this.create();
      this.applyMenu(count);
    } else if (this.tray) {
      this.destroy();
    }
  }

  /**
   * Whether a tray icon currently exists. `main.ts` gates survive-window-close on
   * this so a failed tray creation falls back to quitting on window close rather
   * than stranding a windowless background process with no handle to reopen/quit.
   */
  isActive(): boolean {
    return this.tray !== null;
  }

  /** Remove the tray icon (app shutdown, or no scheduled workflows remain). */
  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
  }

  private create(): void {
    try {
      this.tray = new Tray(trayImage());
      this.tray.setToolTip("AIchemist");
      // On Windows/Linux a left click should reopen the window like an app
      // launcher would. macOS shows the context menu on click by convention, so
      // attaching showWindow there would fight that — gate it to non-darwin.
      if (process.platform !== "darwin") {
        this.tray.on("click", () => this.deps.showWindow());
      }
    } catch (err) {
      // Some headless / unsupported environments have no tray. Never let that
      // break startup — the app simply runs without a tray (and then quits on
      // window close as it did before this feature).
      console.error("[tray] failed to create tray icon:", err);
      this.tray = null;
    }
  }

  private applyMenu(count: number): void {
    if (!this.tray) return;
    const label = count === 1 ? "1 scheduled workflow active" : `${count} scheduled workflows active`;
    const menu = Menu.buildFromTemplate([
      { label: "Open AIchemist", click: () => this.deps.showWindow() },
      { type: "separator" },
      { label, enabled: false },
      { type: "separator" },
      { label: "Quit AIchemist", click: () => this.deps.quit() },
    ]);
    this.tray.setContextMenu(menu);
    this.tray.setToolTip(`AIchemist — ${label}`);
  }
}
