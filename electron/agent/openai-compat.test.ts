// @vitest-environment node
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import * as CH from "../ipc-channels";

vi.mock("../mcp/approval", () => ({
  createManagedMcpBridge: vi.fn(),
}));

// Control the agent file's `model:` frontmatter without touching ~/.claude/agents.
const agentFileMock = vi.hoisted(() => ({ result: null as { body: string; model?: string } | null }));
vi.mock("./claude", () => ({
  readAgentFileSystemPrompt: vi.fn(() => agentFileMock.result),
}));

// Control the tool-round cap without touching the real ~/.aichemist/.env.
const settingsMock = vi.hoisted(() => ({ maxToolRounds: 8 }));
vi.mock("../settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../settings")>();
  return { ...actual, readMaxToolRounds: () => settingsMock.maxToolRounds };
});

import {
  _resetOpenAiCompatProbeCache,
  _setClientFactory,
  _setFetch,
  getOpenAiCompatModels,
  OPENAI_COMPAT_NO_ENDPOINTS_ERROR,
  openaiCompatProvider,
  pickAgentModelTarget,
  runOpenAiCompatTurn,
} from "./openai-compat";
import { _setEndpointsPathForTests, writeOpenAiEndpoints } from "../openai-endpoints";
import { _setNativeTracesRootForTests } from "../native-transcript";
import type { OpenAiEndpointsMap } from "../openai-endpoints";
import { createManagedMcpBridge } from "../mcp/approval";

const FINISH_USAGE = {
  inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 11, text: 11, reasoning: undefined },
};

let tempDir: string;
const tempProjects: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".openai-compat-"));
  tempProjects.push(dir);
  return dir;
}

function setEndpoints(map: OpenAiEndpointsMap): void {
  writeOpenAiEndpoints(map);
}

function makeDb(rows: Array<{ id: string; role: string; content: string }>) {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      all: vi.fn().mockReturnValue(sql.includes("FROM tool_calls") ? [] : rows),
      get: vi.fn().mockReturnValue(sql.includes("disabled_mcp_servers") ? { disabled_mcp_servers: null } : undefined),
      run: vi.fn().mockReturnValue({ changes: 1 }),
    })),
  };
}

/** doStream result that streams text deltas then finishes. */
function textStream(deltas: string[], finishReason: "stop" | "tool-calls" = "stop") {
  return {
    stream: simulateReadableStream({
      chunks: [
        { type: "text-start" as const, id: "t1" },
        ...deltas.map((delta) => ({ type: "text-delta" as const, id: "t1", delta })),
        { type: "text-end" as const, id: "t1" },
        {
          type: "finish" as const,
          finishReason: { unified: finishReason, raw: undefined },
          usage: FINISH_USAGE,
        },
      ],
    }),
  };
}

function mockFetchModels(byUrl: Record<string, string[] | number>) {
  return vi.fn().mockImplementation(async (url: string) => {
    for (const [prefix, value] of Object.entries(byUrl)) {
      if (url.startsWith(prefix)) {
        if (typeof value === "number") {
          return { ok: false, status: value, json: async () => ({}) } as unknown as Response;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: value.map((id) => ({ id })) }),
        } as unknown as Response;
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  settingsMock.maxToolRounds = 8;
  agentFileMock.result = null;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openai-compat-cfg-"));
  _setEndpointsPathForTests(path.join(tempDir, "openai-providers.json"));
  _setNativeTracesRootForTests(path.join(tempDir, "traces"));
  _resetOpenAiCompatProbeCache();
  vi.mocked(createManagedMcpBridge).mockResolvedValue({
    tools: [],
    hasTool: () => false,
    callTool: async () => "",
    close: async () => {},
  });
});

afterEach(() => {
  _setEndpointsPathForTests(null);
  _setNativeTracesRootForTests(null);
  _setFetch(null);
  _setClientFactory(null);
  fs.rmSync(tempDir, { recursive: true, force: true });
  while (tempProjects.length > 0) {
    fs.rmSync(tempProjects.pop()!, { recursive: true, force: true });
  }
});

describe("openai-compat model listing", () => {
  it("aggregates composite model ids across endpoints, skipping dead ones", async () => {
    setEndpoints({
      alpha: { baseURL: "http://alpha.local/v1" },
      beta: { baseURL: "http://beta.local/v1", apiKey: "k" },
      dead: { baseURL: "http://dead.local/v1" },
    });
    const fetchMock = mockFetchModels({
      "http://alpha.local/v1/models": ["m2", "m1"],
      "http://beta.local/v1/models": ["org/model"],
      "http://dead.local/v1/models": 500,
    });
    _setFetch(fetchMock as unknown as typeof fetch);

    const models = await getOpenAiCompatModels();
    expect(models).toEqual([
      { id: "alpha/m1", name: "m1" },
      { id: "alpha/m2", name: "m2" },
      { id: "beta/org/model", name: "org/model" },
    ]);

    // Bearer auth header only where an apiKey is configured.
    const betaCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("http://beta.local"));
    expect(betaCall?.[1]?.headers).toEqual({ Authorization: "Bearer k" });
    const alphaCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("http://alpha.local"));
    expect(alphaCall?.[1]?.headers).toEqual({});
  });

  it("returns an empty list when no endpoints are configured", async () => {
    await expect(getOpenAiCompatModels()).resolves.toEqual([]);
  });

  it("passes an abort signal to fetch so timeouts cancel the request", async () => {
    setEndpoints({ alpha: { baseURL: "http://alpha.local/v1" } });
    const fetchMock = mockFetchModels({ "http://alpha.local/v1/models": ["m1"] });
    _setFetch(fetchMock as unknown as typeof fetch);

    await getOpenAiCompatModels();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("openai-compat probe", () => {
  it("reports not-ok with guidance when no endpoints are configured", async () => {
    const result = await openaiCompatProvider.probe!();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe(OPENAI_COMPAT_NO_ENDPOINTS_ERROR);
  });

  it("reports ok when an endpoint lists at least one model, and caches the result", async () => {
    setEndpoints({ alpha: { baseURL: "http://alpha.local/v1" } });
    const fetchMock = mockFetchModels({ "http://alpha.local/v1/models": ["m1"] });
    _setFetch(fetchMock as unknown as typeof fetch);

    await expect(openaiCompatProvider.probe!()).resolves.toMatchObject({ ok: true });
    await openaiCompatProvider.probe!();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await openaiCompatProvider.probe!({ force: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces the endpoint error when no models are reachable", async () => {
    setEndpoints({ alpha: { baseURL: "http://alpha.local/v1" } });
    _setFetch(mockFetchModels({ "http://alpha.local/v1/models": 401 }) as unknown as typeof fetch);

    const result = await openaiCompatProvider.probe!();
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("HTTP 401");
  });

  it("returns a not-ok result instead of throwing when reading endpoints fails", async () => {
    // Point the config path at a directory so readOpenAiEndpoints() throws
    // EISDIR. probeAll() awaits every provider with Promise.all, so the probe
    // must convert this into { ok: false } rather than reject.
    const dirPath = path.join(tempDir, "is-a-dir");
    fs.mkdirSync(dirPath);
    _setEndpointsPathForTests(dirPath);

    const result = await openaiCompatProvider.probe!();
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

describe("openai-compat turn execution", () => {
  it("streams deltas, replays history, and emits usage", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    const factoryCalls: Array<{ endpointName: string; baseURL: string; modelId: string }> = [];
    let capturedPrompt: unknown;
    _setClientFactory((endpointName, entry) => (modelId) => {
      factoryCalls.push({ endpointName, baseURL: entry.baseURL, modelId });
      return new MockLanguageModelV3({
        doStream: async (options) => {
          capturedPrompt = options.prompt;
          return textStream(["Hel", "lo"]);
        },
      });
    });

    const db = makeDb([
      { id: "m-placeholder", role: "user", content: "placeholder" },
      { id: "m-user", role: "user", content: "hello" },
      { id: "m-assistant", role: "assistant", content: "hi" },
      { id: "m-user-2", role: "user", content: "again" },
    ]);
    const send = vi.fn();

    const text = await runOpenAiCompatTurn({
      db: db as never,
      sessionId: "s-1",
      messageId: "m-placeholder",
      prompt: "again",
      projectPath: makeTempProject(),
      projectConfig: { model: "local/test-model", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send } as never,
    } as never);

    expect(text).toBe("Hello");
    expect(factoryCalls).toEqual([
      { endpointName: "local", baseURL: "http://localhost:1234/v1", modelId: "test-model" },
    ]);
    expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, { session_id: "s-1", text_delta: "Hel" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, { session_id: "s-1", text_delta: "lo" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_USAGE, {
      session_id: "s-1",
      usage: {
        input_tokens: 7,
        output_tokens: 11,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });

    // History reached the model (system + user/assistant/user), placeholder excluded.
    const prompt = capturedPrompt as Array<{ role: string; content: unknown }>;
    expect(prompt.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("appends the prompt when it is not already the last user message (skipPersistence turns)", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    let capturedPrompt: unknown;
    _setClientFactory(() => () =>
      new MockLanguageModelV3({
        doStream: async (options) => {
          capturedPrompt = options.prompt;
          return textStream(["ok"]);
        },
      }),
    );

    const db = makeDb([
      { id: "m-user", role: "user", content: "hello" },
      { id: "m-assistant", role: "assistant", content: "hi" },
    ]);

    await runOpenAiCompatTurn({
      db: db as never,
      sessionId: "s-2",
      messageId: "m-placeholder",
      prompt: "Draft a PR description",
      projectPath: makeTempProject(),
      projectConfig: { model: "local/test-model", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
      noTools: true,
    } as never);

    const prompt = capturedPrompt as Array<{ role: string; content: Array<{ text?: string }> | string }>;
    const last = prompt[prompt.length - 1];
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Draft a PR description");
  });

  it("runs the tool loop: executes read_file and feeds the result back to the model", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, "notes.txt"), "file-content-42");

    const prompts: unknown[] = [];
    let call = 0;
    _setClientFactory(() => () =>
      new MockLanguageModelV3({
        doStream: async (options) => {
          prompts.push(options.prompt);
          call += 1;
          if (call === 1) {
            return {
              stream: simulateReadableStream({
                chunks: [
                  {
                    type: "tool-call" as const,
                    toolCallId: "call-1",
                    toolName: "read_file",
                    input: JSON.stringify({ path: "notes.txt" }),
                  },
                  {
                    type: "finish" as const,
                    finishReason: { unified: "tool-calls" as const, raw: undefined },
                    usage: FINISH_USAGE,
                  },
                ],
              }),
            };
          }
          return textStream(["Done"]);
        },
      }),
    );

    const send = vi.fn();
    const text = await runOpenAiCompatTurn({
      db: makeDb([{ id: "m-user", role: "user", content: "read notes" }]) as never,
      sessionId: "s-3",
      messageId: "m-placeholder",
      prompt: "read notes",
      projectPath,
      projectConfig: { model: "local/test-model", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send } as never,
    } as never);

    expect(text).toBe("Done");
    expect(call).toBe(2);
    expect(send).toHaveBeenCalledWith(
      CH.SESSION_TOOL_CALL,
      expect.objectContaining({ session_id: "s-3", tool_name: "read_file" }),
    );
    expect(send).toHaveBeenCalledWith(
      CH.SESSION_TOOL_RESULT,
      expect.objectContaining({ session_id: "s-3", tool_name: "read_file", output: "file-content-42" }),
    );
    // Second round received the tool result.
    expect(JSON.stringify(prompts[1])).toContain("file-content-42");
  });

  it("surfaces a truncation notice when the tool-round cap is hit", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    settingsMock.maxToolRounds = 1;

    // The model keeps wanting to call tools; with the cap at 1 the AI SDK halts
    // after the first step and the final finishReason stays "tool-calls".
    _setClientFactory(() => () =>
      new MockLanguageModelV3({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call" as const,
                toolCallId: "call-1",
                toolName: "read_file",
                input: JSON.stringify({ path: "notes.txt" }),
              },
              {
                type: "finish" as const,
                finishReason: { unified: "tool-calls" as const, raw: undefined },
                usage: FINISH_USAGE,
              },
            ],
          }),
        }),
      }),
    );

    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, "notes.txt"), "x");
    const send = vi.fn();
    const text = await runOpenAiCompatTurn({
      db: makeDb([{ id: "m-user", role: "user", content: "go" }]) as never,
      sessionId: "s-cap",
      messageId: "m-placeholder",
      prompt: "go",
      projectPath,
      projectConfig: { model: "local/test-model", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send } as never,
    } as never);

    expect(text).toContain("Reached the tool-round limit (1)");
    // The notice is also streamed live as a delta.
    expect(send).toHaveBeenCalledWith(
      CH.SESSION_DELTA,
      expect.objectContaining({
        session_id: "s-cap",
        text_delta: expect.stringContaining("Reached the tool-round limit (1)"),
      }),
    );
  });

  it("does not append a truncation notice when the model finishes normally", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    settingsMock.maxToolRounds = 1;
    _setClientFactory(() => () =>
      new MockLanguageModelV3({ doStream: async () => textStream(["all done"]) }),
    );

    const text = await runOpenAiCompatTurn({
      db: makeDb([{ id: "m-user", role: "user", content: "hi" }]) as never,
      sessionId: "s-nocap",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "local/test-model", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
    } as never);

    expect(text).toBe("all done");
    expect(text).not.toContain("tool-round limit");
  });

  it("falls back to the first listed model when none is configured", async () => {
    setEndpoints({ zeta: { baseURL: "http://zeta.local/v1" } });
    _setFetch(mockFetchModels({ "http://zeta.local/v1/models": ["auto-model"] }) as unknown as typeof fetch);

    const seen: string[] = [];
    _setClientFactory((endpointName) => (modelId) => {
      seen.push(`${endpointName}/${modelId}`);
      return new MockLanguageModelV3({ doStream: async () => textStream(["ok"]) });
    });

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-4",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
    } as never);

    expect(seen).toEqual(["zeta/auto-model"]);
  });

  it("treats a bare model id as belonging to the only configured endpoint", async () => {
    setEndpoints({ solo: { baseURL: "http://solo.local/v1" } });
    const seen: string[] = [];
    _setClientFactory((endpointName) => (modelId) => {
      seen.push(`${endpointName}:${modelId}`);
      return new MockLanguageModelV3({ doStream: async () => textStream(["ok"]) });
    });

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-5",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "qwen2.5-coder", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
    } as never);

    expect(seen).toEqual(["solo:qwen2.5-coder"]);
  });

  it("rejects a model that references no configured endpoint when several exist", async () => {
    setEndpoints({
      a: { baseURL: "http://a.local/v1" },
      b: { baseURL: "http://b.local/v1" },
    });
    await expect(
      runOpenAiCompatTurn({
        db: makeDb([]) as never,
        sessionId: "s-6",
        messageId: "m-placeholder",
        prompt: "hi",
        projectPath: makeTempProject(),
        projectConfig: { model: "unknown-ep/model", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
      } as never),
    ).rejects.toThrow(/does not reference a configured endpoint/);
  });

  it("throws when no endpoints are configured", async () => {
    await expect(
      runOpenAiCompatTurn({
        db: makeDb([]) as never,
        sessionId: "s-7",
        messageId: "m-placeholder",
        prompt: "hi",
        projectPath: makeTempProject(),
        projectConfig: { model: "", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
      } as never),
    ).rejects.toThrow(OPENAI_COMPAT_NO_ENDPOINTS_ERROR);
  });

  it("passes no tools and skips the MCP bridge when noTools is set", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    let capturedTools: unknown;
    _setClientFactory(() => () =>
      new MockLanguageModelV3({
        doStream: async (options) => {
          capturedTools = options.tools;
          return textStream(["ok"]);
        },
      }),
    );

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-8",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "local/m", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
      noTools: true,
    } as never);

    expect(capturedTools ?? []).toEqual([]);
    expect(createManagedMcpBridge).not.toHaveBeenCalled();
  });

  it("surfaces stream errors as turn failures", async () => {
    setEndpoints({ local: { baseURL: "http://localhost:1234/v1" } });
    _setClientFactory(() => () =>
      new MockLanguageModelV3({
        doStream: async () => {
          throw new Error("connection refused");
        },
      }),
    );

    await expect(
      runOpenAiCompatTurn({
        db: makeDb([]) as never,
        sessionId: "s-9",
        messageId: "m-placeholder",
        prompt: "hi",
        projectPath: makeTempProject(),
        projectConfig: { model: "local/m", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
      } as never),
    ).rejects.toThrow(/connection refused/);
  });
});

describe("openai-compat agent model override", () => {
  const ENDPOINTS = {
    alpha: { baseURL: "http://alpha.local/v1" },
    beta: { baseURL: "http://beta.local/v1" },
  };
  const MODELS_FETCH = {
    "http://alpha.local/v1/models": ["model-x"],
    "http://beta.local/v1/models": ["model-y"],
  };

  describe("pickAgentModelTarget", () => {
    const models = [{ id: "alpha/model-x" }, { id: "beta/model-y" }];

    it("matches a composite <endpoint>/<model> override", () => {
      expect(pickAgentModelTarget("beta/model-y", models, ENDPOINTS as never)).toEqual({
        endpointName: "beta",
        entry: ENDPOINTS.beta,
        modelId: "model-y",
      });
    });

    it("matches a bare model id against any endpoint", () => {
      expect(pickAgentModelTarget("model-y", models, ENDPOINTS as never)).toEqual({
        endpointName: "beta",
        entry: ENDPOINTS.beta,
        modelId: "model-y",
      });
    });

    it("matches composite ids whose model portion contains slashes", () => {
      const slashy = [{ id: "together/meta-llama/Llama-3-70b" }];
      expect(
        pickAgentModelTarget("together/meta-llama/Llama-3-70b", slashy, {
          together: { baseURL: "http://together.local/v1" },
        } as never),
      ).toEqual({
        endpointName: "together",
        entry: { baseURL: "http://together.local/v1" },
        modelId: "meta-llama/Llama-3-70b",
      });
    });

    it("returns null for an unknown model or an absent override", () => {
      expect(pickAgentModelTarget("nope", models, ENDPOINTS as never)).toBeNull();
      expect(pickAgentModelTarget(undefined, models, ENDPOINTS as never)).toBeNull();
      expect(pickAgentModelTarget("   ", models, ENDPOINTS as never)).toBeNull();
    });
  });

  it("uses the agent's composite model: override for the turn", async () => {
    setEndpoints(ENDPOINTS);
    agentFileMock.result = { body: "be terse", model: "beta/model-y" };
    _setFetch(mockFetchModels(MODELS_FETCH) as unknown as typeof fetch);

    const seen: string[] = [];
    _setClientFactory((endpointName) => (modelId) => {
      seen.push(`${endpointName}/${modelId}`);
      return new MockLanguageModelV3({ doStream: async () => textStream(["ok"]) });
    });

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-agent-1",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "alpha/model-x", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
      agent: "coder",
    } as never);

    expect(seen).toEqual(["beta/model-y"]);
  });

  it("falls back to the project model when the agent omits a model", async () => {
    setEndpoints(ENDPOINTS);
    agentFileMock.result = { body: "be terse" };

    const seen: string[] = [];
    _setClientFactory((endpointName) => (modelId) => {
      seen.push(`${endpointName}/${modelId}`);
      return new MockLanguageModelV3({ doStream: async () => textStream(["ok"]) });
    });

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-agent-2",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "alpha/model-x", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
      agent: "coder",
    } as never);

    expect(seen).toEqual(["alpha/model-x"]);
  });

  it("warns and falls back to the project model when the agent model is unavailable", async () => {
    setEndpoints(ENDPOINTS);
    agentFileMock.result = { body: "be terse", model: "ghost/model-z" };
    _setFetch(mockFetchModels(MODELS_FETCH) as unknown as typeof fetch);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const seen: string[] = [];
    _setClientFactory((endpointName) => (modelId) => {
      seen.push(`${endpointName}/${modelId}`);
      return new MockLanguageModelV3({ doStream: async () => textStream(["ok"]) });
    });

    await runOpenAiCompatTurn({
      db: makeDb([]) as never,
      sessionId: "s-agent-3",
      messageId: "m-placeholder",
      prompt: "hi",
      projectPath: makeTempProject(),
      projectConfig: { model: "alpha/model-x", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send: vi.fn() } as never,
      agent: "coder",
    } as never);

    expect(seen).toEqual(["alpha/model-x"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost/model-z"));
    warn.mockRestore();
  });

  it("surfaces the no-endpoints error without a misleading model warning when none are configured", async () => {
    // No endpoints configured.
    agentFileMock.result = { body: "be terse", model: "beta/model-y" };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      runOpenAiCompatTurn({
        db: makeDb([]) as never,
        sessionId: "s-agent-4",
        messageId: "m-placeholder",
        prompt: "hi",
        projectPath: makeTempProject(),
        projectConfig: { model: "", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
        agent: "coder",
      } as never),
    ).rejects.toThrow(OPENAI_COMPAT_NO_ENDPOINTS_ERROR);

    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("not available"));
    warn.mockRestore();
  });
});
