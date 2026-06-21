// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _setMemoryRootForTests,
  buildMemoryContext,
  implDeleteMemory,
  implReadMemory,
  implWriteMemory,
  listMemoryFiles,
  memoryDir,
} from "./memory";

const PROJECT = "/work/my-project";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-test-"));
  _setMemoryRootForTests(root);
});

afterEach(() => {
  _setMemoryRootForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

describe("CRUD", () => {
  it("writes, reads, lists, and deletes a memory file", () => {
    expect(listMemoryFiles(PROJECT)).toEqual([]);

    implWriteMemory(PROJECT, "notes.md", "# Conventions\nUse bun.");
    expect(implReadMemory(PROJECT, "notes.md")).toBe("# Conventions\nUse bun.");

    const files = listMemoryFiles(PROJECT);
    expect(files.map((f) => f.name)).toEqual(["notes.md"]);

    implDeleteMemory(PROJECT, "notes.md");
    expect(listMemoryFiles(PROJECT)).toEqual([]);
  });

  it("lists only top-level .md files, sorted case-insensitively", () => {
    implWriteMemory(PROJECT, "Beta.md", "b");
    implWriteMemory(PROJECT, "alpha.md", "a");
    // a non-.md file in the dir must not be listed
    fs.writeFileSync(path.join(memoryDir(PROJECT), "ignore.txt"), "x");

    expect(listMemoryFiles(PROJECT).map((f) => f.name)).toEqual(["alpha.md", "Beta.md"]);
  });

  it("read of a missing file reports not found", () => {
    expect(() => implReadMemory(PROJECT, "nope.md")).toThrow(/not found/i);
  });

  it("write replaces existing content", () => {
    implWriteMemory(PROJECT, "n.md", "first");
    implWriteMemory(PROJECT, "n.md", "second");
    expect(implReadMemory(PROJECT, "n.md")).toBe("second");
  });

  it("writes a large payload in full without truncation", () => {
    const big = "λ".repeat(100 * 1024); // 100k multi-byte chars, under the cap
    implWriteMemory(PROJECT, "big.md", big);
    expect(implReadMemory(PROJECT, "big.md")).toBe(big);
  });
});

describe("name validation", () => {
  it.each([
    ["../escape.md"],
    ["sub/nested.md"],
    ["a\\b.md"],
    ["/abs/path.md"],
  ])("rejects path-bearing name %s", (name) => {
    expect(() => implWriteMemory(PROJECT, name, "x")).toThrow(/flat filename|escapes/i);
  });

  it("rejects non-.md names", () => {
    expect(() => implWriteMemory(PROJECT, "notes.txt", "x")).toThrow(/markdown|\.md/i);
  });

  it("rejects an empty name", () => {
    expect(() => implWriteMemory(PROJECT, "   ", "x")).toThrow(/required/i);
  });
});

describe("memoryDir scoping", () => {
  it("falls back to a deterministic, non-empty segment when sanitize is empty", () => {
    // "/" sanitizes to "" — must not collapse to the shared memory dir.
    const dir = memoryDir("/");
    expect(dir).toBe(memoryDir("/")); // deterministic
    expect(path.basename(dir)).not.toBe("memory");
    expect(path.basename(dir)).not.toBe("");
    expect(dir.startsWith(path.join(root, "memory") + path.sep)).toBe(true);
  });

  it("scopes different projects to different dirs", () => {
    expect(memoryDir("/work/a")).not.toBe(memoryDir("/work/b"));
  });
});

describe("permissions", () => {
  it("tightens an existing world-readable file to 0600 on rewrite", () => {
    implWriteMemory(PROJECT, "p.md", "v1");
    const file = path.join(memoryDir(PROJECT), "p.md");
    fs.chmodSync(file, 0o644);
    implWriteMemory(PROJECT, "p.md", "v2");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});

describe("symlink safety", () => {
  it("refuses to read through a symlinked memory entry", () => {
    implWriteMemory(PROJECT, "seed.md", "x"); // creates the dir
    const secret = path.join(root, "secret.txt");
    fs.writeFileSync(secret, "TOP SECRET");
    fs.symlinkSync(secret, path.join(memoryDir(PROJECT), "link.md"));

    expect(() => implReadMemory(PROJECT, "link.md")).toThrow();
  });

  it("refuses to write through a symlinked memory entry", () => {
    implWriteMemory(PROJECT, "seed.md", "x");
    const target = path.join(root, "target.txt");
    fs.writeFileSync(target, "original");
    fs.symlinkSync(target, path.join(memoryDir(PROJECT), "link.md"));

    expect(() => implWriteMemory(PROJECT, "link.md", "clobbered")).toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("original");
  });

  it("excludes symlinks from listings", () => {
    implWriteMemory(PROJECT, "real.md", "x");
    fs.symlinkSync(path.join(root, "secret.txt"), path.join(memoryDir(PROJECT), "link.md"));
    expect(listMemoryFiles(PROJECT).map((f) => f.name)).toEqual(["real.md"]);
  });

  it("returns an empty list when the memory dir is a symlink", () => {
    const realDir = memoryDir(PROJECT);
    fs.mkdirSync(path.dirname(realDir), { recursive: true });
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "memory-evil-"));
    fs.writeFileSync(path.join(elsewhere, "leak.md"), "leak");
    fs.symlinkSync(elsewhere, realDir);

    expect(listMemoryFiles(PROJECT)).toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("buildMemoryContext", () => {
  it("returns an empty string when there are no memory files", () => {
    expect(buildMemoryContext(PROJECT)).toBe("");
  });

  it("includes saved memory content under a Project Memory heading", () => {
    implWriteMemory(PROJECT, "conv.md", "Always use bun.");
    const ctx = buildMemoryContext(PROJECT);
    expect(ctx).toContain("# Project Memory");
    expect(ctx).toContain("## Memory: conv.md");
    expect(ctx).toContain("Always use bun.");
    // The tool-guidance sentence is included by default.
    expect(ctx).toContain("Use write_memory");
  });

  it("omits the write_memory guidance when includeToolGuidance is false", () => {
    implWriteMemory(PROJECT, "conv.md", "Always use bun.");
    const ctx = buildMemoryContext(PROJECT, { includeToolGuidance: false });
    // The saved notes remain as read-only context …
    expect(ctx).toContain("# Project Memory");
    expect(ctx).toContain("Always use bun.");
    // … but the tool-call phrasing is stripped so text-only turns don't try to
    // call a tool that isn't registered for them.
    expect(ctx).not.toContain("write_memory");
  });

  it("truncates an oversized single file", () => {
    implWriteMemory(PROJECT, "big.md", "A".repeat(70 * 1024)); // > 64 KB per-file cap
    expect(buildMemoryContext(PROJECT)).toContain("[memory file truncated]");
  });

  it("caps the combined block by file count and marks it truncated", () => {
    for (let i = 0; i < 40; i++) {
      implWriteMemory(PROJECT, `m${String(i).padStart(2, "0")}.md`, `note ${i}`);
    }
    const ctx = buildMemoryContext(PROJECT);
    const blockCount = (ctx.match(/## Memory: /g) ?? []).length;
    expect(blockCount).toBe(32); // MAX_MEMORY_FILES
    expect(ctx).toMatch(/project memory truncated: showing 32 of 40 files/);
  });
});
