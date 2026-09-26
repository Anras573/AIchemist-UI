/**
 * Blocks a canvas UI's `<iframe>` (`CanvasFrame`,
 * `src/components/session/CanvasFrame.tsx`) from escaping its own
 * `aichemist-canvas://` origin via self-navigation (`location.href`, a
 * `<meta http-equiv="refresh">`, …).
 *
 * `sandbox="allow-scripts"` (no `allow-same-origin`) still lets a frame
 * navigate *itself* — the sandbox attribute only blocks top-level
 * navigation, popups, and forms — and the protocol's CSP `connect-src
 * 'none'` doesn't cover navigation at all. Left unguarded, canvas UI code
 * can redirect its own iframe to an attacker-controlled origin:
 *
 * 1. **Exfiltrate** anything it holds, including every state/message push.
 * 2. **Hand the bridge to the remote page.** `iframe.contentWindow` keeps
 *    the same identity across a navigation of that frame, so the resulting
 *    remote document passes `CanvasFrame`'s `event.source ===
 *    iframe.contentWindow` check exactly as the canvas's own script did —
 *    an origin check wouldn't help either, since the opaque sandboxed
 *    origin serializes as `"null"` on both sides. From then on the remote
 *    page can send arbitrary `ui.message`s to the canvas host and receives
 *    every later state/message/theme post.
 *
 * Neither the CSP nor the sandbox attribute can close this — it can only be
 * enforced in the main process, on the window's `WebContents` (found in
 * review on PR #235).
 *
 * Only the scheme is checked, not a specific canvas id: `CanvasFrame` reuses
 * one persistent `<iframe>` across canvas switches, updating `src` to a
 * *different* canvas's `aichemist-canvas://` URL — a legitimate navigation
 * this guard must not block.
 */
import { CANVAS_PROTOCOL_SCHEME } from "./protocol";

/** True if a sub-frame may navigate to `url`. Main-frame navigation is never checked — see {@link installCanvasFrameNavigationGuard}. */
export function isAllowedCanvasFrameNavigation(url: string): boolean {
  try {
    return new URL(url).protocol === `${CANVAS_PROTOCOL_SCHEME}:`;
  } catch {
    return false;
  }
}

/** The subset of `Electron.WebContents` this guard depends on (test seam — avoids spinning up a real `BrowserWindow` in tests). */
export interface NavigationGuardedWebContents {
  on(
    event: "will-frame-navigate",
    listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void
  ): unknown;
  setWindowOpenHandler(handler: () => { action: "deny" }): void;
}

/**
 * Installs the guard on a window's `webContents`: blocks any sub-frame
 * navigation whose target isn't `aichemist-canvas:` (a main-frame navigation
 * — the app's own window loading its dev/prod URL — is never restricted),
 * and denies every `window.open()` popup attempt as further defense in
 * depth (a sandboxed iframe without `allow-popups` can't open one anyway,
 * but this closes the door app-wide rather than relying on that alone).
 */
export function installCanvasFrameNavigationGuard(webContents: NavigationGuardedWebContents): void {
  webContents.on("will-frame-navigate", (details) => {
    if (details.isMainFrame) return;
    if (!isAllowedCanvasFrameNavigation(details.url)) {
      details.preventDefault();
    }
  });
  webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}
