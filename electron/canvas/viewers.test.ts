import { describe, expect, it } from "vitest";
import { CanvasViewerTracker } from "./viewers";

describe("CanvasViewerTracker", () => {
  it("keeps an instance open until its last viewer leaves", () => {
    const t = new CanvasViewerTracker();
    expect(t.add("c", 1)).toBe(1);
    expect(t.add("c", 2)).toBe(2);
    expect(t.remove("c", 1)).toBe(1);
    expect(t.remove("c", 2)).toBe(0);
  });

  it("releaseSender reports only instances left with no viewer", () => {
    const t = new CanvasViewerTracker();
    t.add("a", 1);
    t.add("b", 1);
    t.add("b", 2);
    expect(t.releaseSender(1)).toEqual(["a"]);
  });
});
