// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as CH from "../ipc-channels";

// Capture every handler registered via ipcMain.handle so we can invoke them
// directly (handle() wraps each one in an IpcEnvelope-returning function).
type WrappedHandler = (event: unknown, ...args: unknown[]) => Promise<{
  ok: boolean;
  data?: unknown;
  error?: unknown;
}>;
const handlers = new Map<string, WrappedHandler>();
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, cb: WrappedHandler) => {
      handlers.set(channel, cb);
    },
  },
}));

// resolveProjectDir is the only claude-transcript export LIST_MEMORY touches.
// Keep the real module (memory.ts also imports sanitizeCwd from it) and override
// just resolveProjectDir so we control where the "Claude store" lives.
const resolveProjectDirMock = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("../claude-transcript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../claude-transcript")>();
  return {
    ...actual,
    resolveProjectDir: (...args: unknown[]) => resolveProjectDirMock.fn(...args),
  };
});

import { registerTraceHandlers } from "./trace-handlers";
import { _setMemoryRootForTests, implWriteMemory } from "../agent/memory";

const PROJECT = "/work/my-project";
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function listMemory(args: unknown): Promise<Array<{ name: string; path: string }>> {
  const handler = handlers.get(CH.LIST_MEMORY)!;
  const env = await handler({}, args);
  expect(env.ok).toBe(true);
  return (env.data as { files: Array<{ name: string; path: string }> }).files;
}

beforeEach(() => {
  handlers.clear();
  resolveProjectDirMock.fn.mockReset();
  _setMemoryRootForTests(makeTempDir("trace-memory-root-"));
  // db is never touched by LIST_MEMORY; a bare stub is enough to register.
  registerTraceHandlers({} as never, () => null);
});

afterEach(() => {
  _setMemoryRootForTests(null);
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("LIST_MEMORY", () => {
  it("returns the AIchemist memory store for an Ollama session", async () => {
    implWriteMemory(PROJECT, "ollama-note.md", "remember bun");

    const files = await listMemory({ projectPath: PROJECT, provider: "ollama" });
    expect(files.map((f) => f.name)).toEqual(["ollama-note.md"]);
  });

  it("returns the AIchemist memory store for a Copilot session", async () => {
    // Copilot reuses the same ~/.aichemist/memory store as the self-driven
    // providers, so its notes are portable across providers for a project.
    implWriteMemory(PROJECT, "copilot-note.md", "remember gh token");

    const files = await listMemory({ projectPath: PROJECT, provider: "copilot" });
    expect(files.map((f) => f.name)).toEqual(["copilot-note.md"]);
  });

  it("returns the SDK-owned store for a Claude session", async () => {
    const claudeProjectDir = makeTempDir("trace-claude-proj-");
    fs.mkdirSync(path.join(claudeProjectDir, "memory"));
    fs.writeFileSync(path.join(claudeProjectDir, "memory", "claude-note.md"), "x");
    resolveProjectDirMock.fn.mockResolvedValue(claudeProjectDir);

    const files = await listMemory({ projectPath: PROJECT, provider: "anthropic" });
    expect(files.map((f) => f.name)).toEqual(["claude-note.md"]);
  });

  it("keeps the two providers' stores isolated from each other", async () => {
    // Ollama store: only the native note.
    implWriteMemory(PROJECT, "ollama-only.md", "native");
    // Claude store: only the SDK note.
    const claudeProjectDir = makeTempDir("trace-claude-proj-");
    fs.mkdirSync(path.join(claudeProjectDir, "memory"));
    fs.writeFileSync(path.join(claudeProjectDir, "memory", "claude-only.md"), "sdk");
    resolveProjectDirMock.fn.mockResolvedValue(claudeProjectDir);

    const ollamaFiles = await listMemory({ projectPath: PROJECT, provider: "ollama" });
    expect(ollamaFiles.map((f) => f.name)).toEqual(["ollama-only.md"]);

    const claudeFiles = await listMemory({ projectPath: PROJECT, provider: "anthropic" });
    expect(claudeFiles.map((f) => f.name)).toEqual(["claude-only.md"]);
  });

  it("treats a bare projectPath string as a Claude request (back-compat)", async () => {
    const claudeProjectDir = makeTempDir("trace-claude-proj-");
    fs.mkdirSync(path.join(claudeProjectDir, "memory"));
    fs.writeFileSync(path.join(claudeProjectDir, "memory", "legacy.md"), "x");
    resolveProjectDirMock.fn.mockResolvedValue(claudeProjectDir);

    const files = await listMemory(PROJECT);
    expect(files.map((f) => f.name)).toEqual(["legacy.md"]);
  });

  it("returns an empty list for an unknown provider", async () => {
    // Even if a Claude store happens to exist on disk, a non-Claude request for a
    // provider with no recognised store must not surface it.
    const claudeProjectDir = makeTempDir("trace-claude-proj-");
    fs.mkdirSync(path.join(claudeProjectDir, "memory"));
    fs.writeFileSync(path.join(claudeProjectDir, "memory", "claude-note.md"), "x");
    resolveProjectDirMock.fn.mockResolvedValue(claudeProjectDir);

    const files = await listMemory({ projectPath: PROJECT, provider: "some-future-provider" });
    expect(files).toEqual([]);
  });
});
