// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  installCanvasFrameNavigationGuard,
  isAllowedCanvasFrameNavigation,
  type NavigationGuardedWebContents,
} from "./frame-navigation-guard";

describe("isAllowedCanvasFrameNavigation", () => {
  it("allows an aichemist-canvas:// URL", () => {
    expect(isAllowedCanvasFrameNavigation("aichemist-canvas://some-canvas-id/index.html")).toBe(true);
  });

  it("allows a different canvas id under the same scheme (legitimate canvas-switch navigation)", () => {
    expect(isAllowedCanvasFrameNavigation("aichemist-canvas://a-different-canvas-id/index.html")).toBe(true);
  });

  it("refuses an http(s) URL", () => {
    expect(isAllowedCanvasFrameNavigation("https://attacker.example/?stolen=board")).toBe(false);
    expect(isAllowedCanvasFrameNavigation("http://attacker.example/")).toBe(false);
  });

  it("refuses a javascript: URL", () => {
    expect(isAllowedCanvasFrameNavigation("javascript:alert(1)")).toBe(false);
  });

  it("refuses a data: URL", () => {
    expect(isAllowedCanvasFrameNavigation("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("refuses an unparseable URL", () => {
    expect(isAllowedCanvasFrameNavigation("not a url")).toBe(false);
  });
});

// ─── Fake WebContents ────────────────────────────────────────────────────────

class FakeWebContents implements NavigationGuardedWebContents {
  private navigateListener: ((details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void) | null =
    null;
  windowOpenHandler: (() => { action: "deny" }) | null = null;

  on(
    _event: "will-frame-navigate",
    listener: (details: { url: string; isMainFrame: boolean; preventDefault: () => void }) => void
  ): void {
    this.navigateListener = listener;
  }

  setWindowOpenHandler(handler: () => { action: "deny" }): void {
    this.windowOpenHandler = handler;
  }

  /** Simulates Electron firing `will-frame-navigate` and returns whether it was prevented. */
  fireNavigate(url: string, isMainFrame: boolean): boolean {
    let prevented = false;
    this.navigateListener?.({ url, isMainFrame, preventDefault: () => { prevented = true; } });
    return prevented;
  }
}

describe("installCanvasFrameNavigationGuard", () => {
  it("blocks a sub-frame navigation to a remote origin", () => {
    const wc = new FakeWebContents();
    installCanvasFrameNavigationGuard(wc);
    expect(wc.fireNavigate("https://attacker.example/?stolen=board", false)).toBe(true);
  });

  it("allows a sub-frame navigation within the aichemist-canvas:// scheme", () => {
    const wc = new FakeWebContents();
    installCanvasFrameNavigationGuard(wc);
    expect(wc.fireNavigate("aichemist-canvas://some-canvas-id/index.html", false)).toBe(false);
  });

  it("allows a sub-frame navigation switching to a different canvas id", () => {
    const wc = new FakeWebContents();
    installCanvasFrameNavigationGuard(wc);
    expect(wc.fireNavigate("aichemist-canvas://another-canvas-id/index.html", false)).toBe(false);
  });

  it("never restricts a main-frame navigation, even to a URL the sub-frame check would refuse", () => {
    const wc = new FakeWebContents();
    installCanvasFrameNavigationGuard(wc);
    expect(wc.fireNavigate("https://example.com/", true)).toBe(false);
  });

  it("registers a window-open handler that denies every popup", () => {
    const wc = new FakeWebContents();
    installCanvasFrameNavigationGuard(wc);
    expect(wc.windowOpenHandler?.()).toEqual({ action: "deny" });
  });
});
