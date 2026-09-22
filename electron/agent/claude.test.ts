import { describe, it, expect } from "vitest";
import { buildFileChange } from "./claude";

// ─── buildFileChange ────────────────────────────────────────────────────────
//
// Pure function extracted from the SDK message loop so the before/after →
// FileChange logic (diff / binary / too-large classification) can be tested
// without spinning up a query stream. See issue #206: the surrounding I/O
// (readFileForDiff) was switched from readFileSync to async fs.promises so a
// large file being diffed can't block the main process event loop.

describe("buildFileChange", () => {
  it("computes a unified diff for text content", () => {
    const change = buildFileChange({
      filePath: "/project/src/foo.ts",
      relPath: "src/foo.ts",
      before: Buffer.from("old line\n"),
      beforeTooLarge: false,
      after: Buffer.from("new line\n"),
      afterTooLarge: false,
    });

    expect(change.isBinary).toBeUndefined();
    expect(change.tooLarge).toBeUndefined();
    expect(change.operation).toBe("write");
    expect(change.diff).toContain("-old line");
    expect(change.diff).toContain("+new line");
  });

  it("treats a null before-buffer as an empty file (new file)", () => {
    const change = buildFileChange({
      filePath: "/project/src/new.ts",
      relPath: "src/new.ts",
      before: null,
      beforeTooLarge: false,
      after: Buffer.from("created content\n"),
      afterTooLarge: false,
    });

    expect(change.diff).toContain("+created content");
  });

  it("marks the change binary when either buffer contains a NUL byte", () => {
    const change = buildFileChange({
      filePath: "/project/assets/img.png",
      relPath: "assets/img.png",
      before: Buffer.from([0x89, 0x50, 0x00, 0x47]),
      beforeTooLarge: false,
      after: Buffer.from([0x89, 0x50, 0x00, 0x47]),
      afterTooLarge: false,
    });

    expect(change.isBinary).toBe(true);
    expect(change.diff).toBe("");
    expect(change.tooLarge).toBeUndefined();
  });

  it("marks the change too-large when the before content exceeded the size threshold", () => {
    const change = buildFileChange({
      filePath: "/project/data/huge.json",
      relPath: "data/huge.json",
      before: null,
      beforeTooLarge: true,
      after: Buffer.from("small after\n"),
      afterTooLarge: false,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.diff).toBe("");
    expect(change.isBinary).toBeUndefined();
  });

  it("marks the change too-large when the after content exceeded the size threshold", () => {
    const change = buildFileChange({
      filePath: "/project/data/huge.json",
      relPath: "data/huge.json",
      before: Buffer.from("small before\n"),
      beforeTooLarge: false,
      after: null,
      afterTooLarge: true,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.diff).toBe("");
  });

  it("prioritizes too-large over binary detection", () => {
    const change = buildFileChange({
      filePath: "/project/assets/huge.bin",
      relPath: "assets/huge.bin",
      before: Buffer.from([0x00, 0x01]),
      beforeTooLarge: true,
      after: Buffer.from([0x00, 0x01]),
      afterTooLarge: false,
    });

    expect(change.tooLarge).toBe(true);
    expect(change.isBinary).toBeUndefined();
  });
});
