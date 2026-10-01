import { describe, expect, it, vi } from "vitest";
import { CanvasPopoutManager, type PopoutWindowLike } from "./popout";

function fakeWin(id: number) {
  let closed: () => void = () => {};
  const win = {
    destroyed: false,
    webContents: { id, send: vi.fn(), isDestroyed: () => win.destroyed },
    isDestroyed: () => win.destroyed,
    isMinimized: () => false,
    restore: vi.fn(),
    focus: vi.fn(),
    on: (_e: "closed", l: () => void) => {
      closed = l;
    },
    close() {
      win.destroyed = true;
      closed();
    },
  };
  return win as typeof win & PopoutWindowLike;
}

function setup() {
  const main = { webContents: { send: vi.fn(), isDestroyed: () => false } };
  const wins: ReturnType<typeof fakeWin>[] = [];
  const onClosed = vi.fn();
  const createWindow = vi.fn(() => {
    const w = fakeWin(10 + wins.length);
    wins.push(w);
    return w;
  });
  const mgr = new CanvasPopoutManager({ getMainWindow: () => main, createWindow, onClosed });
  return { main, wins, onClosed, createWindow, mgr };
}

describe("CanvasPopoutManager", () => {
  const meta = { title: "T", definition: "kanban" };

  it("focuses an existing pop-out instead of opening a second", () => {
    const { mgr, createWindow, wins } = setup();
    mgr.open("c1", meta);
    mgr.open("c1", meta);
    expect(createWindow).toHaveBeenCalledTimes(1);
    expect(wins[0].focus).toHaveBeenCalled();
  });

  it("broadcasts to the main window and every pop-out", () => {
    const { mgr, main, wins } = setup();
    mgr.open("c1", meta);
    mgr.open("c2", meta);
    mgr.broadcast("ch", { x: 1 });
    expect(main.webContents.send).toHaveBeenCalledWith("ch", { x: 1 });
    expect(wins[0].webContents.send).toHaveBeenCalledWith("ch", { x: 1 });
    expect(wins[1].webContents.send).toHaveBeenCalledWith("ch", { x: 1 });
  });

  it("stops sending to a closed pop-out and reports its webContents id", () => {
    const { mgr, wins, onClosed } = setup();
    mgr.open("c1", meta);
    wins[0].close();
    mgr.broadcast("ch", 1);
    expect(wins[0].webContents.send).not.toHaveBeenCalled();
    expect(onClosed).toHaveBeenCalledWith(10);
    expect(mgr.isOpen("c1")).toBe(false);
  });

  it("close() closes only that instance's pop-out", () => {
    const { mgr, wins, onClosed } = setup();
    mgr.open("c1", meta);
    mgr.open("c2", meta);
    mgr.close("c1");
    expect(mgr.isOpen("c1")).toBe(false);
    expect(mgr.isOpen("c2")).toBe(true);
    expect(onClosed).toHaveBeenCalledWith(wins[0].webContents.id);
    mgr.close("nope"); // no-op
  });
});
