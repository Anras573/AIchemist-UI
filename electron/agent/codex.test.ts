import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentProviderParams } from "./provider";
import type { ThreadEvent } from "@openai/codex-sdk";

// ── Hoisted mock state ────────────────────────────────────────────────────────
const { recorderMock } = vi.hoisted(() => ({
  recorderMock: {
    turnStart: vi.fn(),
    reasoning: vi.fn(),
    usage: vi.fn(),
    turnEnd: vi.fn(),
    toolCall: vi.fn(),
    toolResult: vi.fn(),
  },
}));

// Safety net: if a test path ever reaches the lazy SDK import (it shouldn't —
// run tests inject a client via _setCodexForTests), keep it harmless.
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn() }));

vi.mock("../config", () => ({
  getApiKey: vi.fn((key) => (key === "openai" ? "sk-test-key" : null)),
}));

vi.mock("./provider-session-store", () => ({
  providerSessionStore: { get: vi.fn(() => ({})), set: vi.fn(), reset: vi.fn() },
}));

vi.mock("./turn-emitter", () => ({
  TurnEmitter: vi.fn(function (this: any) {
    this.delta = vi.fn();
    this.usage = vi.fn();
    this.toolCall = vi.fn();
    this.toolResult = vi.fn();
    this.fileChange = vi.fn();
  }),
}));

vi.mock("./skills", () => ({ buildSkillsContext: vi.fn(() => "") }));
vi.mock("./memory", () => ({ buildMemoryContext: vi.fn(() => "") }));
vi.mock("./claude", () => ({ readAgentFileSystemPrompt: vi.fn(() => null) }));
vi.mock("../native-transcript", () => ({
  createNativeTranscriptRecorder: vi.fn(() => recorderMock),
}));

import {
  codexProvider,
  _setCodexForTests,
  _setFetchForTests,
  _resetProbeCacheForTests,
} from "./codex";
import { getApiKey } from "../config";
import { readAgentFileSystemPrompt } from "./claude";
import { providerSessionStore } from "./provider-session-store";
import { TurnEmitter } from "./turn-emitter";

// ── Event + client builders ───────────────────────────────────────────────────
const ev = {
  threadStarted: (id: string): ThreadEvent => ({ type: "thread.started", thread_id: id }),
  agentMessage: (text: string, id = "msg-1"): ThreadEvent => ({
    type: "item.completed",
    item: { id, type: "agent_message", text },
  }),
  usage: (input = 10, output = 5, cached = 2): ThreadEvent => ({
    type: "turn.completed",
    usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0 },
  }),
  commandStarted: (id: string, command: string): ThreadEvent => ({
    type: "item.started",
    item: { id, type: "command_execution", command, aggregated_output: "", status: "in_progress" },
  }),
  commandCompleted: (id: string, command: string, output: string, failed = false): ThreadEvent => ({
    type: "item.completed",
    item: {
      id,
      type: "command_execution",
      command,
      aggregated_output: output,
      exit_code: failed ? 1 : 0,
      status: failed ? "failed" : "completed",
    },
  }),
  fileChangeCompleted: (
    id: string,
    changes: Array<{ path: string; kind: "add" | "delete" | "update" }>,
    status: "completed" | "failed" = "completed",
  ): ThreadEvent => ({
    type: "item.completed",
    item: { id, type: "file_change", changes, status },
  }),
  mcpCompleted: (id: string, server: string, tool: string, content: unknown[]): ThreadEvent => ({
    type: "item.completed",
    item: {
      id,
      type: "mcp_tool_call",
      server,
      tool,
      arguments: {},
      result: { content: content as any, structured_content: undefined },
      status: "completed",
    },
  }),
  turnFailed: (message: string): ThreadEvent => ({ type: "turn.failed", error: { message } }),
};

function makeThread(events: ThreadEvent[], id: string | null = "thread-new") {
  const runStreamed = vi.fn(async () => ({
    events: (async function* () {
      for (const e of events) yield e;
    })(),
  }));
  return { get id() { return id; }, runStreamed };
}

function makeCodex(opts: { startThread?: any; resumeThread?: any } = {}) {
  return {
    startThread: opts.startThread ?? vi.fn(() => makeThread([ev.agentMessage("ok"), ev.usage()])),
    resumeThread: opts.resumeThread ?? vi.fn(() => makeThread([ev.agentMessage("ok"), ev.usage()])),
  };
}

const lastEmitter = () => (TurnEmitter as unknown as { mock: { instances: any[] } }).mock.instances.at(-1);

describe("codexProvider (SDK-backed)", () => {
  function makeParams(overrides: Partial<AgentProviderParams> = {}): AgentProviderParams {
    return {
      db: {} as any,
      sessionId: "session-123",
      messageId: "msg-123",
      prompt: "Hello, Codex!",
      projectPath: "/project",
      projectConfig: { provider: "codex", model: "gpt-5.1-codex" } as any,
      webContents: { send: vi.fn() } as any,
      skills: [],
      agent: undefined,
      noTools: false,
      nonInteractive: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockImplementation((key) => (key === "openai" ? "sk-test-key" : null));
    vi.mocked(providerSessionStore.get).mockReturnValue({});
    _setCodexForTests(makeCodex() as any);
    _resetProbeCacheForTests();
    _setFetchForTests(
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({
          data: [{ id: "gpt-4o" }, { id: "o3-mini" }, { id: "omni-moderation-latest" }],
        }),
      }) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    _setCodexForTests(null);
    _setFetchForTests(null);
    _resetProbeCacheForTests();
  });

  it("starts a new thread and streams agent_message text", async () => {
    const startThread = vi.fn(() =>
      makeThread([ev.threadStarted("thread-abc"), ev.agentMessage("Hello "), ev.agentMessage("Codex"), ev.usage()]),
    );
    _setCodexForTests(makeCodex({ startThread }) as any);

    const result = await codexProvider.run(makeParams({ db: {} as any }));

    expect(result).toBe("Hello Codex");
    expect(startThread).toHaveBeenCalledTimes(1);
    // Thread options carry the resolved model + workspace sandbox.
    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ model: "gpt-5.1-codex", sandboxMode: "workspace-write", workingDirectory: "/project" }),
    );
    expect(providerSessionStore.set).toHaveBeenCalledWith({}, "session-123", "codex", { threadId: "thread-abc" });
    expect(lastEmitter().delta).toHaveBeenCalledWith("Hello ");
    expect(lastEmitter().delta).toHaveBeenCalledWith("Codex");
  });

  it("resumes the stored thread instead of starting a new one", async () => {
    vi.mocked(providerSessionStore.get).mockReturnValue({ threadId: "thread-resumed" });
    const resumeThread = vi.fn(() => makeThread([ev.agentMessage("resumed")], "thread-resumed"));
    const startThread = vi.fn();
    _setCodexForTests(makeCodex({ startThread, resumeThread }) as any);

    const result = await codexProvider.run(makeParams());

    expect(resumeThread).toHaveBeenCalledWith("thread-resumed", expect.objectContaining({ skipGitRepoCheck: true }));
    expect(startThread).not.toHaveBeenCalled();
    expect(result).toBe("resumed");
  });

  it("maps token usage onto the emitter (cached → cache_read)", async () => {
    _setCodexForTests(makeCodex({ startThread: vi.fn(() => makeThread([ev.agentMessage("x"), ev.usage(100, 40, 7)])) }) as any);

    await codexProvider.run(makeParams());

    expect(lastEmitter().usage).toHaveBeenCalledWith({
      input_tokens: 100,
      output_tokens: 40,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 7,
    });
    expect(recorderMock.usage).toHaveBeenCalledWith({ input: 100, output: 40, cacheRead: 7, cacheCreation: 0 });
  });

  it("surfaces command_execution items as tool call + result on the timeline and recorder", async () => {
    _setCodexForTests(
      makeCodex({
        startThread: vi.fn(() =>
          makeThread([
            ev.commandStarted("cmd-1", "ls -la"),
            ev.commandCompleted("cmd-1", "ls -la", "total 0\n"),
            ev.agentMessage("done"),
            ev.usage(),
          ]),
        ),
      }) as any,
    );

    const result = await codexProvider.run(makeParams());

    expect(result).toBe("done");
    expect(lastEmitter().toolCall).toHaveBeenCalledWith("cmd-1", "execute_bash", { command: "ls -la" });
    expect(lastEmitter().toolCall).toHaveBeenCalledTimes(1); // not double-emitted on completion
    expect(lastEmitter().toolResult).toHaveBeenCalledWith("execute_bash", "total 0\n");
    expect(recorderMock.toolResult).toHaveBeenCalledWith("cmd-1", "total 0\n", false);
  });

  it("drives the Changes panel from successful file_change items", async () => {
    _setCodexForTests(
      makeCodex({
        startThread: vi.fn(() =>
          makeThread([
            ev.fileChangeCompleted("fc-1", [
              { path: "src/new.ts", kind: "add" },
              { path: "/project/src/gone.ts", kind: "delete" },
            ]),
            ev.fileChangeCompleted("fc-2", [{ path: "src/skip.ts", kind: "update" }], "failed"),
            ev.agentMessage("done"),
            ev.usage(),
          ]),
        ),
      }) as any,
    );

    await codexProvider.run(makeParams());

    const fc = lastEmitter().fileChange;
    // Relative path resolved against projectPath -> absolute; delete kind mapped.
    expect(fc).toHaveBeenCalledWith({
      path: "/project/src/new.ts",
      relativePath: "src/new.ts",
      diff: "",
      operation: "write",
    });
    expect(fc).toHaveBeenCalledWith({
      path: "/project/src/gone.ts",
      relativePath: "src/gone.ts",
      diff: "",
      operation: "delete",
    });
    // The failed patch is not surfaced as a change.
    expect(fc).toHaveBeenCalledTimes(2);
  });

  it("renders mcp_tool_call text content as raw text (not JSON-escaped)", async () => {
    _setCodexForTests(
      makeCodex({
        startThread: vi.fn(() =>
          makeThread([
            ev.mcpCompleted("mcp-1", "tickets", "lookup", [{ type: "text", text: "ticket #42: open" }]),
            ev.agentMessage("done"),
            ev.usage(),
          ]),
        ),
      }) as any,
    );

    await codexProvider.run(makeParams());

    expect(lastEmitter().toolCall).toHaveBeenCalledWith("mcp-1", "tickets.lookup", {});
    expect(lastEmitter().toolResult).toHaveBeenCalledWith("tickets.lookup", "ticket #42: open");
  });

  it("throws on turn.failed and finalizes the transcript as error", async () => {
    _setCodexForTests(
      makeCodex({ startThread: vi.fn(() => makeThread([ev.turnFailed("model exploded")])) }) as any,
    );

    await expect(codexProvider.run(makeParams())).rejects.toThrow("model exploded");
    expect(recorderMock.turnEnd).toHaveBeenCalledWith("error");
  });

  it("uses read-only sandbox and skips the transcript for noTools turns", async () => {
    const startThread = vi.fn(() => makeThread([ev.agentMessage("text only"), ev.usage()]));
    _setCodexForTests(makeCodex({ startThread }) as any);

    await codexProvider.run(makeParams({ noTools: true }));

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: "read-only", approvalPolicy: "never" }),
    );
    expect(recorderMock.turnStart).not.toHaveBeenCalled();
  });

  it("does not read or write provider_state for noTools (skipPersistence) turns", async () => {
    // A stored thread exists, but a throwaway noTools turn must not resume it or
    // persist its own ephemeral thread id over it.
    vi.mocked(providerSessionStore.get).mockReturnValue({ threadId: "real-thread" });
    const resumeThread = vi.fn();
    const startThread = vi.fn(() => makeThread([ev.threadStarted("ephemeral"), ev.agentMessage("draft"), ev.usage()]));
    _setCodexForTests(makeCodex({ startThread, resumeThread }) as any);

    await codexProvider.run(makeParams({ noTools: true }));

    expect(providerSessionStore.get).not.toHaveBeenCalled();
    expect(providerSessionStore.set).not.toHaveBeenCalled();
    expect(resumeThread).not.toHaveBeenCalled(); // started fresh, didn't touch the real thread
  });

  it("uses workspace-write + never-approve for nonInteractive (autonomous) turns", async () => {
    const startThread = vi.fn(() => makeThread([ev.agentMessage("auto"), ev.usage()]));
    _setCodexForTests(makeCodex({ startThread }) as any);

    await codexProvider.run(makeParams({ nonInteractive: true }));

    expect(startThread).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxMode: "workspace-write", approvalPolicy: "never" }),
    );
  });

  it("honors a selected agent's model override and prepends its body to the input", async () => {
    vi.mocked(readAgentFileSystemPrompt).mockReturnValue({ body: "Agent instructions", model: "gpt-5.3-codex" });
    const thread = makeThread([ev.agentMessage("ok"), ev.usage()]);
    const startThread = vi.fn(() => thread);
    _setCodexForTests(makeCodex({ startThread }) as any);

    await codexProvider.run(makeParams({ agent: "my-agent" }));

    expect(readAgentFileSystemPrompt).toHaveBeenCalledWith("my-agent");
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ model: "gpt-5.3-codex" }));
    expect(thread.runStreamed).toHaveBeenCalledWith(
      expect.stringContaining("Agent instructions"),
    );
  });

  it("omits the model so Codex uses its default when none is configured", async () => {
    const startThread = vi.fn(() => makeThread([ev.agentMessage("ok"), ev.usage()]));
    _setCodexForTests(makeCodex({ startThread }) as any);

    await codexProvider.run(makeParams({ projectConfig: { provider: "codex", model: null } as any }));

    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ model: undefined }));
  });

  it("throws when the API key is unconfigured", async () => {
    vi.mocked(getApiKey).mockReturnValue("   ");
    _setCodexForTests(null);

    await expect(codexProvider.run(makeParams())).rejects.toThrow("OpenAI API key not configured");
  });

  it("lists only Codex-capable models", async () => {
    const models = await codexProvider.listModels?.();
    expect(models).toEqual([
      { id: "gpt-4o", name: "gpt-4o" },
      { id: "o3-mini", name: "o3-mini" },
    ]);
  });

  it("honors OPENAI_BASE_URL for model listing and strips a trailing slash", async () => {
    const prev = process.env.OPENAI_BASE_URL;
    process.env.OPENAI_BASE_URL = "https://proxy.example.com/v1/";
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-4o" }] }) });
    _setFetchForTests(fetchSpy as unknown as typeof fetch);
    try {
      await codexProvider.listModels?.();
      // No double slash despite the trailing slash in the env value.
      expect(fetchSpy).toHaveBeenCalledWith("https://proxy.example.com/v1/models", expect.anything());
    } finally {
      if (prev === undefined) delete process.env.OPENAI_BASE_URL;
      else process.env.OPENAI_BASE_URL = prev;
    }
  });

  it("probes successfully with a valid API key and caches until forced", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-4o" }] }) });
    _setFetchForTests(fetchSpy as unknown as typeof fetch);

    await expect(codexProvider.probe?.()).resolves.toMatchObject({ ok: true });
    await codexProvider.probe?.();
    await codexProvider.probe?.({ force: true });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("reports an unconfigured key during probe without fetching", async () => {
    vi.mocked(getApiKey).mockReturnValue("   ");
    const fetchSpy = vi.fn();
    _setFetchForTests(fetchSpy as unknown as typeof fetch);

    await expect(codexProvider.probe?.({ force: true })).resolves.toMatchObject({
      ok: false,
      reason: "OpenAI API key not configured",
      durationMs: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("stops gracefully", async () => {
    await expect(codexProvider.stop?.()).resolves.toBeUndefined();
  });
});
