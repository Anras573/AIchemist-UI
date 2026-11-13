// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

import { execFile } from "child_process";
import {
  cleanupManagedWorktree,
  createManagedWorktree,
  isGitRepo,
  resolveManagedWorktreeRoot,
} from "./worktree";

const mockExecFile = vi.mocked(execFile);

type GitOutcome = { status: number; stdout?: string; stderr?: string };
const mockOutcome = (o: GitOutcome, once = false) => {
  const impl = ((_cmd: string, _args: string[], _opts: unknown, cb: (...a: unknown[]) => void) => {
    if (o.status === 0) cb(null, o.stdout ?? "", o.stderr ?? "");
    else cb(Object.assign(new Error("git failed"), { code: o.status }), o.stdout ?? "", o.stderr ?? "");
  }) as never;
  if (once) mockExecFile.mockImplementationOnce(impl);
  else mockExecFile.mockImplementation(impl);
};

describe("resolveManagedWorktreeRoot", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to the project parent when no override is set", async () => {
    const projectPath = path.join(tmpDir, "repo");
    const result = resolveManagedWorktreeRoot(projectPath);
    expect(result.managedRoot).toBe(tmpDir);
  });

  it("uses a valid override path", async () => {
    const override = path.join(tmpDir, "managed");
    fs.mkdirSync(override);
    const result = resolveManagedWorktreeRoot(path.join(tmpDir, "repo"), override);
    expect(result.managedRoot).toBe(override);
  });

  it("falls back and warns for an invalid override path", async () => {
    const result = resolveManagedWorktreeRoot(path.join(tmpDir, "repo"), path.join(tmpDir, "missing"));
    expect(result.managedRoot).toBe(tmpDir);
    expect(result.warning).toMatch(/Invalid worktree root path/);
  });
});

describe("worktree git helpers", () => {
  beforeEach(() => {
    mockExecFile.mockReset();
  });

  it("detects git repositories via rev-parse", async () => {
    mockOutcome({ status: 0, stdout: "true\n", stderr: "" });
    expect(await isGitRepo("/repo")).toBe(true);
  });

  it("creates a managed worktree on the first successful attempt", async () => {
    mockOutcome({ status: 0, stdout: "", stderr: "" });
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");

    const result = await createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.branch).toBe("aichemist/session-123");
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123"));
    expect(mockExecFile).toHaveBeenCalledWith(
      "git",
      ["-C", "/repo", "worktree", "add", "-b", "aichemist/session-123", path.join(managedRoot, "aichemist-session-123")],
      expect.objectContaining({ encoding: "utf8" }),
      expect.any(Function)
    );
  });

  it("retries with a suffix when the first attempt fails", async () => {
    mockOutcome({ status: 1, stderr: "already exists" }, true);
    mockOutcome({ status: 0 }, true);
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");

    const result = await createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.branch).toBe("aichemist/session-123-1");
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123-1"));
  });

  it("does not remove a pre-existing non-empty folder", async () => {
    mockOutcome({ status: 1, stderr: "already exists" }, true);
    mockOutcome({ status: 0 }, true);
    const managedRoot = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aichemist-worktree-root-")), "managed");
    const occupiedPath = path.join(managedRoot, "aichemist-session-123");
    const markerFile = path.join(occupiedPath, "keep.txt");
    fs.mkdirSync(occupiedPath, { recursive: true });
    fs.writeFileSync(markerFile, "keep");

    const result = await createManagedWorktree("/repo", "session-123", managedRoot);

    expect(result.created).toBe(true);
    expect(result.workspacePath).toBe(path.join(managedRoot, "aichemist-session-123-1"));
    expect(fs.existsSync(markerFile)).toBe(true);
  });

  it("removes the worktree, prunes metadata, and deletes the branch", async () => {
    mockOutcome({ status: 0, stdout: "", stderr: "" });

    await cleanupManagedWorktree({
      repoRoot: "/repo",
      workspacePath: "/managed/aichemist-session-123",
      branch: "aichemist/session-123",
    });

    expect(mockExecFile).toHaveBeenNthCalledWith(
      1,
      "git",
      ["-C", "/repo", "worktree", "remove", "--force", "/managed/aichemist-session-123"],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "git",
      ["-C", "/repo", "worktree", "prune"],
      expect.any(Object),
      expect.any(Function)
    );
    expect(mockExecFile).toHaveBeenNthCalledWith(
      3,
      "git",
      ["-C", "/repo", "branch", "-D", "aichemist/session-123"],
      expect.any(Object),
      expect.any(Function)
    );
  });
});
