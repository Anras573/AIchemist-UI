// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("child_process");

import * as fs from "fs";
import * as childProcess from "child_process";
import {
  implWriteFile,
  implDeleteFile,
  implExecuteBash,
  implWebFetch,
  implWriteFileWithChange,
  implDeleteFileWithChange,
} from "./tool-impls";

// ── implWriteFile ─────────────────────────────────────────────────────────────

describe("implWriteFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it("creates parent directories and writes the file", async () => {
    const result = await implWriteFile({ path: "/tmp/foo/bar.txt", content: "hello" });

    expect(fs.mkdirSync).toHaveBeenCalledWith("/tmp/foo", { recursive: true });
    expect(fs.writeFileSync).toHaveBeenCalledWith("/tmp/foo/bar.txt", "hello", "utf8");
    expect(result).toBe("File written: /tmp/foo/bar.txt");
  });

  it("returns an error message when writeFileSync throws an Error", async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = await implWriteFile({ path: "/root/secret.txt", content: "data" });
    expect(result).toBe("Error writing file: EACCES: permission denied");
  });

  it("returns an error message when writeFileSync throws a non-Error", async () => {
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw "disk full"; // eslint-disable-line @typescript-eslint/only-throw-error
    });

    const result = await implWriteFile({ path: "/tmp/a.txt", content: "x" });
    expect(result).toBe("Error writing file: disk full");
  });
});

// ── implDeleteFile ────────────────────────────────────────────────────────────

describe("implDeleteFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
  });

  it("deletes the file and returns a success message", async () => {
    const result = await implDeleteFile({ path: "/tmp/foo.txt" });

    expect(fs.unlinkSync).toHaveBeenCalledWith("/tmp/foo.txt");
    expect(result).toBe("File deleted: /tmp/foo.txt");
  });

  it("returns an error message when unlinkSync throws an Error", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const result = await implDeleteFile({ path: "/tmp/missing.txt" });
    expect(result).toBe("Error deleting file: ENOENT: no such file or directory");
  });

  it("returns an error message when unlinkSync throws a non-Error", async () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw 42; // eslint-disable-line @typescript-eslint/only-throw-error
    });

    const result = await implDeleteFile({ path: "/tmp/a.txt" });
    expect(result).toBe("Error deleting file: 42");
  });
});

// ── implExecuteBash ───────────────────────────────────────────────────────────

describe("implExecuteBash", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stdout, stderr, and exit_code from spawnSync", async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      stdout: "hello\n",
      stderr: "",
      status: 0,
      pid: 1,
      output: [],
      signal: null,
      error: undefined,
    });

    const result = await implExecuteBash({ command: "echo hello" });

    expect(childProcess.spawnSync).toHaveBeenCalledWith("echo hello", {
      shell: true,
      cwd: undefined,
      encoding: "utf8",
    });
    expect(JSON.parse(result)).toEqual({ stdout: "hello\n", stderr: "", exit_code: 0 });
  });

  it("forwards cwd to spawnSync when provided", async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      stdout: "",
      stderr: "err\n",
      status: 1,
      pid: 2,
      output: [],
      signal: null,
      error: undefined,
    });

    const result = await implExecuteBash({ command: "ls", cwd: "/some/dir" });

    expect(childProcess.spawnSync).toHaveBeenCalledWith("ls", {
      shell: true,
      cwd: "/some/dir",
      encoding: "utf8",
    });
    expect(JSON.parse(result)).toMatchObject({ exit_code: 1, stderr: "err\n" });
  });

  it("uses -1 as exit_code when status is null (e.g. process killed by signal)", async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      stdout: "",
      stderr: "",
      status: null,
      pid: 3,
      output: [],
      signal: "SIGKILL",
      error: undefined,
    });

    const result = await implExecuteBash({ command: "sleep 999" });
    expect(JSON.parse(result)).toMatchObject({ exit_code: -1 });
  });

  it("uses empty string for stdout/stderr when they are null", async () => {
    vi.mocked(childProcess.spawnSync).mockReturnValue({
      stdout: null as unknown as string,
      stderr: null as unknown as string,
      status: 0,
      pid: 4,
      output: [],
      signal: null,
      error: undefined,
    });

    const result = await implExecuteBash({ command: "true" });
    expect(JSON.parse(result)).toEqual({ stdout: "", stderr: "", exit_code: 0 });
  });
});

// ── implWebFetch ──────────────────────────────────────────────────────────────

describe("implWebFetch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns url, status, content_type, and body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: vi.fn().mockReturnValue("text/html; charset=utf-8") },
        text: vi.fn().mockResolvedValue("<html>ok</html>"),
      })
    );

    const result = await implWebFetch({ url: "https://example.com" });
    expect(JSON.parse(result)).toEqual({
      url: "https://example.com",
      status: 200,
      content_type: "text/html; charset=utf-8",
      body: "<html>ok</html>",
    });
  });

  it("uses empty string for content_type when the header is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: vi.fn().mockReturnValue(null) },
        text: vi.fn().mockResolvedValue("body"),
      })
    );

    const result = await implWebFetch({ url: "https://example.com/no-ct" });
    expect(JSON.parse(result)).toMatchObject({ content_type: "" });
  });

  it("returns an error message when fetch rejects", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await implWebFetch({ url: "https://example.com" });
    expect(result).toBe("Error fetching URL: network error");
  });

  it("returns an error message when fetch throws a non-Error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("timeout"));

    const result = await implWebFetch({ url: "https://example.com" });
    expect(result).toBe("Error fetching URL: timeout");
  });
});

// ── implWriteFileWithChange — path validation ─────────────────────────────────

describe("implWriteFileWithChange path validation", () => {
  const projectPath = "/project";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("writes a file within the project root", async () => {
    const { result } = await implWriteFileWithChange(
      { path: "/project/src/foo.ts", content: "hello" },
      projectPath
    );
    expect(result).toContain("File written:");
  });

  it("rejects a path that escapes the project boundary via ../", async () => {
    const { result } = await implWriteFileWithChange(
      { path: "../outside.txt", content: "evil" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(result).toContain("escapes project boundary");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects an absolute path outside the project root", async () => {
    const { result } = await implWriteFileWithChange(
      { path: "/etc/passwd", content: "evil" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects writes to .git/", async () => {
    const { result } = await implWriteFileWithChange(
      { path: ".git/hooks/pre-commit", content: "evil" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(result).toContain("sensitive path");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects writes to node_modules/", async () => {
    const { result } = await implWriteFileWithChange(
      { path: "node_modules/pkg/index.js", content: "evil" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects writes to .env files", async () => {
    const { result } = await implWriteFileWithChange(
      { path: ".env.production", content: "SECRET=evil" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects content that exceeds the 10 MB size limit", async () => {
    const bigContent = "x".repeat(10 * 1024 * 1024 + 1);
    const { result } = await implWriteFileWithChange(
      { path: "big.txt", content: bigContent },
      projectPath
    );
    expect(result).toContain("10 MB");
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ── implDeleteFileWithChange — path validation ────────────────────────────────

describe("implDeleteFileWithChange path validation", () => {
  const projectPath = "/project";

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.unlinkSync).mockReturnValue(undefined);
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
  });

  it("deletes a file within the project root", async () => {
    const { result } = await implDeleteFileWithChange(
      { path: "/project/src/old.ts" },
      projectPath
    );
    expect(result).toContain("File deleted:");
  });

  it("rejects a path that escapes the project boundary via ../", async () => {
    const { result } = await implDeleteFileWithChange(
      { path: "../../etc/passwd" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(result).toContain("escapes project boundary");
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("rejects deletes in .git/", async () => {
    const { result } = await implDeleteFileWithChange(
      { path: ".git/config" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });

  it("rejects deletes of .env files", async () => {
    const { result } = await implDeleteFileWithChange(
      { path: ".env" },
      projectPath
    );
    expect(result).toContain("Error:");
    expect(fs.unlinkSync).not.toHaveBeenCalled();
  });
});
