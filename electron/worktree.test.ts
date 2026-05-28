// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "child_process";
import {
  cleanupManagedWorktree,
  createManagedWorktree,
  isGitRepo,
  resolveManagedWorktreeRoot,
} from "./worktree";

const mockSpawnSync = vi.mocked(spawnSync);

describe("resolveManagedWorktreeRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to the project parent when no override is set", () => {
    const projectPath = path.join(tmpDir, "repo");
    const result = resolveManagedWorktreeRoot(projectPath);
    expect(result.managedRoot).toBe(tmpDir);
  });

  it("uses a valid override path", () => {
    const override = path.join(tmpDir, "managed");
    fs.mkdirSync(override);
    const result = resolveManagedWorktreeRoot(path.join(tmpDir, "repo"), override);
    expect(result.managedRoot).toBe(override);
  });

  it("falls back and warns for an invalid override path", () => {
    const result = resolveManagedWorktreeRoot(path.join(tmpDir, "repo"), path.join(tmpDir, "missing"));
    expect(result.managedRoot).toBe(tmpDir);
    expect(result.warning).toMatch(/Invalid worktree root path/);
  });
});

describe("worktree git helpers", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("detects git repositories via rev-parse", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "true\n", stderr: "" } as never);
    expect(isGitRepo("/repo")).toBe(true);
  });

  it("creates a managed worktree on the first successful attempt", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");

    const result = createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.branch).toBe("aichemist/session-123");
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123"));
    expect(mockSpawnSync).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "worktree", "add", "-b", "aichemist/session-123", path.join(managedRoot, "aichemist-session-123")],
      expect.objectContaining({ encoding: "utf8" })
    );
  });

  it("retries with a suffix when the first attempt fails", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never);
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");

    const result = createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.branch).toBe("aichemist/session-123-1");
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123-1"));
  });

  it("does not remove a pre-existing non-empty folder", () => {
    mockSpawnSync
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "already exists" } as never)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" } as never);
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");
    const occupiedPath = path.join(managedRoot, "aichemist-session-123");
    const markerFile = path.join(occupiedPath, "keep.txt");
    fs.mkdirSync(occupiedPath, { recursive: true });
    fs.writeFileSync(markerFile, "keep");

    const result = createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123-1"));
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("removes the worktree, prunes metadata, and deletes the branch", () => {
    mockSpawnSync.mockReturnValue({ status: 0, stdout: "", stderr: "" } as never);

    cleanupManagedWorktree({
      repoRoot: "/repo",
      workspacePath: "/managed/aichemist-session-123",
      branch: "aichemist/session-123",
    });

    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-C", "/repo", "worktree", "remove", "--force", "/managed/aichemist-session-123"],
      expect.any(Object)
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", "/repo", "worktree", "prune"],
      expect.any(Object)
    );
    expect(mockSpawnSync).toHaveBeenNthCalledWith(
      3,
      "git",
      ["-C", "/repo", "branch", "-D", "aichemist/session-123"],
      expect.any(Object)
    );
  });
});
