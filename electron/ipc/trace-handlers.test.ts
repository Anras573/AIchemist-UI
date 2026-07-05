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

// getProjectConfig resolves the effective provider for a legacy null-provider
// session; keep the rest of ../projects real and control just that lookup.
const getProjectConfigMock = vi.hoisted(() => ({ fn: vi.fn((..._args: unknown[]) => ({ provider: "anthropic" })) }));
vi.mock("../projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../projects")>();
  return { ...actual, getProjectConfig: (...args: unknown[]) => getProjectConfigMock.fn(...args) };
});

import Database from "better-sqlite3";
import type { TraceSpan } from "../../src/types/index";
import { registerTraceHandlers } from "./trace-handlers";
import { _setMemoryRootForTests, implWriteMemory } from "../agent/memory";
import { _setNativeTracesRootForTests, createNativeTranscriptRecorder } from "../native-transcript";

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

  it("returns the AIchemist memory store for a Codex session", async () => {
    // Codex uses the same ~/.aichemist/memory store (its turns inject
    // buildMemoryContext from memoryDir), so the panel must list it too.
    implWriteMemory(PROJECT, "codex-note.md", "remember sandbox");

    const files = await listMemory({ projectPath: PROJECT, provider: "codex" });
    expect(files.map((f) => f.name)).toEqual(["codex-note.md"]);
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

// #130 parity matrix — trace integrity at the IPC boundary. Proves GET_TRACES
// routes each provider to the right transcript source: Codex (and the other
// self-driven providers) → the native transcript; a session with an SDK id →
// the Claude/Copilot branch; a legacy null-provider session → the project's
// default provider. (Approvals / MCP / workflow parity are covered by
// codex(-app-server|-approval-bridge).test.ts and workflow-scheduler.test.ts.)
describe("GET_TRACES — trace parity matrix", () => {
  let db: Database.Database;

  function insertSession(opts: {
    id: string;
    provider?: string | null;
    sdkSessionId?: string | null;
    copilotSessionId?: string | null;
  }): void {
    db.prepare(
      `INSERT INTO sessions (id, project_id, provider, provider_state, sdk_session_id, copilot_session_id, workspace_path)
       VALUES (?, 'proj-1', ?, NULL, ?, ?, NULL)`,
    ).run(opts.id, opts.provider ?? null, opts.sdkSessionId ?? null, opts.copilotSessionId ?? null);
  }

  function writeNativeTranscript(sessionId: string, provider: "codex" | "ollama" | "openai-compatible"): void {
    const rec = createNativeTranscriptRecorder(sessionId, provider);
    rec.turnStart("gpt-5.1-codex");
    rec.toolCall("t1", "execute_bash", { command: "ls" });
    rec.toolResult("t1", "total 0", false);
    rec.turnEnd("success");
  }

  async function getTraces(sessionId?: string): Promise<TraceSpan[]> {
    const env = await handlers.get(CH.GET_TRACES)!({}, sessionId);
    expect(env.ok).toBe(true);
    return env.data as TraceSpan[];
  }

  beforeEach(() => {
    getProjectConfigMock.fn.mockReturnValue({ provider: "anthropic" });
    // An empty Claude project dir so the Claude branch cleanly finds no file.
    resolveProjectDirMock.fn.mockResolvedValue(makeTempDir("trace-claude-root-"));
    _setNativeTracesRootForTests(makeTempDir("trace-native-root-"));
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, project_id TEXT, provider TEXT, provider_state TEXT,
        sdk_session_id TEXT, copilot_session_id TEXT, workspace_path TEXT
      );
    `);
    db.prepare("INSERT INTO projects (id, path) VALUES ('proj-1', ?)").run(PROJECT);
    handlers.clear();
    registerTraceHandlers(db as never, () => null);
  });

  afterEach(() => {
    _setNativeTracesRootForTests(null);
    db.close();
  });

  it("routes a Codex session to its native transcript and returns parsed spans", async () => {
    insertSession({ id: "cdx-1", provider: "codex" });
    writeNativeTranscript("cdx-1", "codex");

    const spans = await getTraces("cdx-1");
    const turn = spans.find((s) => s.type === "turn");
    const tool = spans.find((s) => s.type === "tool");
    expect(turn?.status).toBe("success");
    expect(turn?.id).toMatch(/^turn:native:cdx-1:/);
    expect(tool?.name).toBe("execute_bash");
    expect(tool?.parentId).toBe(turn?.id);
  });

  it.each(["ollama", "openai-compatible"] as const)(
    "routes a %s session to the same native transcript path (parity)",
    async (provider) => {
      insertSession({ id: `s-${provider}`, provider });
      writeNativeTranscript(`s-${provider}`, provider);
      expect((await getTraces(`s-${provider}`)).some((s) => s.type === "turn")).toBe(true);
    },
  );

  it("falls back to the project default provider for a legacy null-provider session", async () => {
    getProjectConfigMock.fn.mockReturnValue({ provider: "codex" });
    insertSession({ id: "legacy-1", provider: null });
    writeNativeTranscript("legacy-1", "codex");

    expect((await getTraces("legacy-1")).some((s) => s.type === "turn")).toBe(true);
    expect(getProjectConfigMock.fn).toHaveBeenCalled();
  });

  it("returns an empty list for a Codex session that hasn't run yet", async () => {
    insertSession({ id: "cdx-empty", provider: "codex" });
    expect(await getTraces("cdx-empty")).toEqual([]);
  });

  it("routes by SDK id, not file existence: an SDK-id session skips the native transcript", async () => {
    // A native transcript exists for this id, but the presence of an sdk_session_id
    // must route to the Claude branch (which finds no file here) — proving routing
    // wins over file existence, so the native spans are NOT returned.
    writeNativeTranscript("claude-1", "codex");
    insertSession({ id: "claude-1", provider: "anthropic", sdkSessionId: "sdk-abc" });
    expect(await getTraces("claude-1")).toEqual([]);
  });

  it("returns an empty list for an unknown session id", async () => {
    expect(await getTraces("nope")).toEqual([]);
  });
});
