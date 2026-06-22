// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal electron stub: a Tray double that records its menu/tooltip/handlers,
// plus the Menu/nativeImage surfaces the tray module touches. Built inside
// vi.hoisted so it exists before the hoisted vi.mock factory references it.
interface MenuItem {
  label?: string;
  type?: string;
  enabled?: boolean;
  click?: () => void;
}
interface FakeTray {
  destroyed: boolean;
  tooltip: string;
  menu: { template: MenuItem[] } | null;
  handlers: Record<string, () => void>;
}
const { FakeTrayClass, instances } = vi.hoisted(() => {
  const instances: FakeTray[] = [];
  class FakeTrayClass {
    destroyed = false;
    tooltip = "";
    menu: { template: MenuItem[] } | null = null;
    handlers: Record<string, () => void> = {};
    constructor() {
      instances.push(this);
    }
    setToolTip(t: string): void {
      this.tooltip = t;
    }
    setContextMenu(m: { template: MenuItem[] }): void {
      this.menu = m;
    }
    on(ev: string, fn: () => void): void {
      this.handlers[ev] = fn;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  return { FakeTrayClass, instances };
});

vi.mock("electron", () => ({
  Menu: { buildFromTemplate: (template: MenuItem[]) => ({ template }) },
  nativeImage: {
    createFromDataURL: () => ({ isEmpty: () => false, resize: () => ({ isEmpty: () => false }) }),
  },
  Tray: FakeTrayClass,
}));

import { TrayController } from "./tray";

describe("TrayController", () => {
  let count: number;
  let showWindow: ReturnType<typeof vi.fn<() => void>>;
  let quit: ReturnType<typeof vi.fn<() => void>>;
  let tray: TrayController;

  /** Build a controller with an injected platform (defaults to process.platform). */
  function makeTray(platform?: NodeJS.Platform): TrayController {
    return new TrayController({ showWindow, getScheduledCount: () => count, quit, platform });
  }

  beforeEach(() => {
    instances.length = 0;
    count = 0;
    showWindow = vi.fn<() => void>();
    quit = vi.fn<() => void>();
    tray = makeTray();
  });

  it("does not create a tray while no workflow is scheduled", () => {
    tray.refresh();
    expect(instances).toHaveLength(0);
    expect(tray.isActive()).toBe(false);
  });

  it("creates the tray when the scheduled count rises above zero", () => {
    count = 2;
    tray.refresh();
    expect(instances).toHaveLength(1);
    const t = instances[0];
    expect(t.tooltip).toContain("2 scheduled workflows active");
    // Menu: Open, separator, count label (disabled), separator, Quit.
    const labels = t.menu!.template.filter((m) => m.label).map((m) => m.label);
    expect(labels).toEqual([
      "Open AIchemist",
      "2 scheduled workflows active",
      "Quit AIchemist",
    ]);
  });

  it("singularizes the label for exactly one workflow", () => {
    count = 1;
    tray.refresh();
    expect(instances[0].tooltip).toContain("1 scheduled workflow active");
  });

  it("wires the Open and Quit menu actions", () => {
    count = 1;
    tray.refresh();
    const t = instances[0];
    t.menu!.template.find((m) => m.label === "Open AIchemist")!.click!();
    expect(showWindow).toHaveBeenCalledTimes(1);
    t.menu!.template.find((m) => m.label === "Quit AIchemist")!.click!();
    expect(quit).toHaveBeenCalledTimes(1);
  });

  // The left-click → showWindow handler is attached off macOS only (macOS shows
  // the context menu on click by convention). Platform is injected so both
  // branches run deterministically on a single CI OS (CI is Ubuntu-only).
  it("attaches the left-click → reopen handler off macOS", () => {
    count = 1;
    makeTray("linux").refresh();
    const t = instances[0];
    expect(t.handlers["click"]).toBeDefined();
    t.handlers["click"]!();
    expect(showWindow).toHaveBeenCalledTimes(1);
  });

  it("does not attach a click handler on macOS", () => {
    count = 1;
    makeTray("darwin").refresh();
    expect(instances[0].handlers["click"]).toBeUndefined();
  });

  it("reuses the same tray across refreshes and updates the count", () => {
    count = 1;
    tray.refresh();
    count = 3;
    tray.refresh();
    expect(instances).toHaveLength(1);
    expect(instances[0].tooltip).toContain("3 scheduled workflows active");
  });

  it("destroys the tray when the scheduled count returns to zero", () => {
    count = 1;
    tray.refresh();
    expect(tray.isActive()).toBe(true);
    const t = instances[0];
    count = 0;
    tray.refresh();
    expect(t.destroyed).toBe(true);
    expect(tray.isActive()).toBe(false);
  });

  it("destroy() tears down an existing tray", () => {
    count = 1;
    tray.refresh();
    tray.destroy();
    expect(instances[0].destroyed).toBe(true);
  });
});
