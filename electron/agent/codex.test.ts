import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AgentProviderParams } from "./provider";

// Mock OpenAI SDK first (before any imports)
vi.mock("openai", () => {
  class MockOpenAI {
    beta = {
      threads: {
        create: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
        retrieve: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
        messages: {
          create: vi.fn(async () => ({
            id: "msg-123",
            thread_id: "thread-123",
            role: "user" as const,
            content: [{ type: "text", text: "test" }],
            created_at: 1719360000,
          })),
        },
        runs: {
          stream: vi.fn(async function* () {
            yield {
              event: "thread.message.delta",
              data: {
                delta: {
                  content: [{ type: "text", text: "Hello " }],
                },
              },
            };
            yield {
              event: "thread.message.delta",
              data: {
                delta: {
                  content: [{ type: "text", text: "Codex" }],
                },
              },
            };
            yield {
              event: "thread.run.completed",
              data: {
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 5,
                  total_tokens: 15,
                },
              },
            };
          }),
        },
      },
    };
  }
  return { default: MockOpenAI };
});

// Mock getApiKey
vi.mock("../config", () => ({
  getApiKey: vi.fn((key) => {
    if (key === "openai") return "sk-test-key";
    return undefined;
  }),
}));

// Mock provider session store
vi.mock("./provider-session-store", () => ({
  providerSessionStore: {
    get: vi.fn(() => ({})),
    set: vi.fn(),
    reset: vi.fn(),
  },
}));

// Mock TurnEmitter
vi.mock("./turn-emitter", () => ({
  TurnEmitter: vi.fn(function (this: any) {
    this.delta = vi.fn();
    this.usage = vi.fn();
  }),
}));

// Mock helper modules
vi.mock("./skills", () => ({
  buildSkillsContext: vi.fn(() => ""),
}));

vi.mock("./memory", () => ({
  buildMemoryContext: vi.fn(() => ""),
}));

vi.mock("./claude", () => ({
  readAgentFileSystemPrompt: vi.fn(() => null),
}));

// Now import the provider
import {
  codexProvider,
  _normalizeTextContentForTests,
  _resetProbeCacheForTests,
  _setClientForTests,
  _setFetchForTests,
} from "./codex";
import { getApiKey } from "../config";
import { providerSessionStore } from "./provider-session-store";
import { TurnEmitter } from "./turn-emitter";

type TurnEmitterMock = {
  mock: {
    instances: Array<{
      delta: ReturnType<typeof vi.fn>;
      usage: ReturnType<typeof vi.fn>;
    }>;
  };
  mockImplementation: (impl: (this: any) => void) => unknown;
};

const mockedTurnEmitter = TurnEmitter as unknown as TurnEmitterMock;

function installDefaultTurnEmitterMock() {
  mockedTurnEmitter.mockImplementation(function (this: any) {
    this.isDefault = true;
    this.delta = vi.fn();
    this.usage = vi.fn();
  });
}

describe("codexProvider", () => {
  function makeParams(overrides: Partial<AgentProviderParams> = {}): AgentProviderParams {
    return {
      db: {} as any,
      sessionId: "session-123",
      messageId: "msg-123",
      prompt: "Hello, Codex!",
      projectPath: "/project",
      projectConfig: {
        provider: "codex",
        model: "gpt-4",
      } as any,
      webContents: {
        send: vi.fn(),
      } as any,
      skills: [],
      agent: undefined,
      noTools: false,
      nonInteractive: false,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getApiKey).mockImplementation((key) => {
      if (key === "openai") return "sk-test-key";
      return null;
    });
    installDefaultTurnEmitterMock();
    _setClientForTests(null); // Reset client singleton
    _resetProbeCacheForTests();
    _setFetchForTests(
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-4o" }, { id: "gpt-4.1" }] }),
      }) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
    _resetProbeCacheForTests();
    _setFetchForTests(null);
  });

  it("should create a new thread when none exists", async () => {
    const mockDb = {} as any;
    const params = makeParams({ db: mockDb });

    const result = await codexProvider.run(params);

    expect(result).toBe("Hello Codex");
    expect(providerSessionStore.set).toHaveBeenCalledWith(mockDb, "session-123", "codex", {
      threadId: "thread-123",
    });
  });

  it("should normalize text payloads from the SDK", () => {
    expect(_normalizeTextContentForTests("plain text")).toBe("plain text");
    expect(_normalizeTextContentForTests({ value: "object text" })).toBe("object text");
    expect(_normalizeTextContentForTests({ value: 123 })).toBeUndefined();
    expect(_normalizeTextContentForTests({})).toBeUndefined();
  });

  it("should fall back to the default model when project config model is null", async () => {
    const stream = vi.fn(async function* () {
      yield {
        event: "thread.run.completed",
        data: {
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
        },
      };
    });
    _setClientForTests({
      threads: {
        create: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
        retrieve: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-123",
          role: "user",
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: { stream },
    } as any);

    await codexProvider.run(
      makeParams({
        projectConfig: {
          provider: "codex",
          model: null,
        } as any,
      })
    );

    expect(stream).toHaveBeenCalledWith(
      "thread-123",
      expect.objectContaining({ model: "gpt-4" })
    );
  });

  it("should persist the thread id before streaming so failures can resume", async () => {
    const mockDb = {} as any;
    const emitterDelta = vi.fn();
    const emitterUsage = vi.fn();
    mockedTurnEmitter.mockImplementation(function (this: any) {
      this.delta = emitterDelta;
      this.usage = emitterUsage;
    });

    _setClientForTests({
      threads: {
        create: vi.fn(async () => ({ id: "thread-456", created_at: 1719360000 })),
        retrieve: vi.fn(async () => ({ id: "thread-456", created_at: 1719360000 })),
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-456",
          role: "user" as const,
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: {
        stream: vi.fn(async function* () {
          throw new Error("stream failed");
        }),
      },
    } as any);

    await expect(codexProvider.run(makeParams({ db: mockDb }))).rejects.toThrow("stream failed");

    expect(providerSessionStore.set).toHaveBeenCalledWith(mockDb, "session-123", "codex", {
      threadId: "thread-456",
    });
    expect(emitterDelta).not.toHaveBeenCalled();
    expect(emitterUsage).not.toHaveBeenCalled();
  });

  it("should resume an existing thread when one is stored", async () => {
    const retrieve = vi.fn(async () => ({ id: "thread-resumed", created_at: 1719360000 }));
    const create = vi.fn(async () => ({ id: "thread-new", created_at: 1719360000 }));
    vi.mocked(providerSessionStore.get).mockReturnValueOnce({ threadId: "thread-resumed" });

    _setClientForTests({
      threads: {
        create,
        retrieve,
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-resumed",
          role: "user" as const,
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: {
        stream: vi.fn(async function* () {
          yield {
            event: "thread.run.completed",
            data: {
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        }),
      },
    } as any);

    await codexProvider.run(makeParams());

    expect(retrieve).toHaveBeenCalledWith("thread-resumed");
    expect(create).not.toHaveBeenCalled();
    expect(providerSessionStore.set).toHaveBeenCalledWith(expect.anything(), "session-123", "codex", {
      threadId: "thread-resumed",
    });
  });

  it("should create a fresh thread when the stored thread no longer exists", async () => {
    const retrieve = vi.fn(async () => {
      throw new Error("thread not found");
    });
    const create = vi.fn(async () => ({ id: "thread-recreated", created_at: 1719360000 }));
    vi.mocked(providerSessionStore.get).mockReturnValueOnce({ threadId: "thread-stale" });

    _setClientForTests({
      threads: {
        create,
        retrieve,
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-recreated",
          role: "user" as const,
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: {
        stream: vi.fn(async function* () {
          yield {
            event: "thread.run.completed",
            data: {
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        }),
      },
    } as any);

    await codexProvider.run(makeParams());

    expect(retrieve).toHaveBeenCalledWith("thread-stale");
    expect(create).toHaveBeenCalledTimes(1);
    expect(providerSessionStore.set).toHaveBeenCalledWith(expect.anything(), "session-123", "codex", {
      threadId: "thread-recreated",
    });
  });

  it("should rethrow transient thread retrieval failures instead of recreating the thread", async () => {
    const retrieve = vi.fn(async () => {
      throw new Error("connection reset");
    });
    const create = vi.fn(async () => ({ id: "thread-recreated", created_at: 1719360000 }));
    vi.mocked(providerSessionStore.get).mockReturnValueOnce({ threadId: "thread-stale" });

    _setClientForTests({
      threads: {
        create,
        retrieve,
      },
      messages: {
        create: vi.fn(),
      },
      runs: {
        stream: vi.fn(),
      },
    } as any);

    await expect(codexProvider.run(makeParams())).rejects.toThrow("connection reset");

    expect(retrieve).toHaveBeenCalledWith("thread-stale");
    expect(create).not.toHaveBeenCalled();
    expect(providerSessionStore.set).not.toHaveBeenCalled();
  });

  it("should stream only normalized text deltas", async () => {
    const emitterDelta = vi.fn();
    const emitterUsage = vi.fn();
    mockedTurnEmitter.mockImplementation(function (this: any) {
      this.delta = emitterDelta;
      this.usage = emitterUsage;
    });

    _setClientForTests({
      threads: {
        create: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
        retrieve: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-123",
          role: "user",
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: {
        stream: vi.fn(async function* () {
          yield {
            event: "thread.message.delta",
            data: {
              delta: {
                content: [
                  { type: "text", text: { value: "Hello " } },
                  { type: "text", text: { bad: true } },
                  { type: "text", text: "Codex" },
                ],
              },
            },
          };
        }),
      },
    } as any);

    const result = await codexProvider.run(makeParams());

    expect(result).toBe("Hello Codex");
    expect(emitterDelta).toHaveBeenCalledTimes(2);
    expect(emitterDelta).toHaveBeenNthCalledWith(1, "Hello ");
    expect(emitterDelta).toHaveBeenNthCalledWith(2, "Codex");
    expect(emitterDelta).not.toHaveBeenCalledWith("[object Object]");
    expect(emitterUsage).not.toHaveBeenCalled();
  });

  it("should restore the default TurnEmitter mock between tests", async () => {
    _setClientForTests({
      threads: {
        create: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
        retrieve: vi.fn(async () => ({ id: "thread-123", created_at: 1719360000 })),
      },
      messages: {
        create: vi.fn(async () => ({
          id: "msg-123",
          thread_id: "thread-123",
          role: "user",
          content: [{ type: "text", text: "test" }],
          created_at: 1719360000,
        })),
      },
      runs: {
        stream: vi.fn(async function* () {
          yield {
            event: "thread.run.completed",
            data: {
              usage: {
                prompt_tokens: 1,
                completion_tokens: 1,
                total_tokens: 2,
              },
            },
          };
        }),
      },
    } as any);

    await codexProvider.run(makeParams());

    expect((mockedTurnEmitter as any).mock.instances.at(-1)?.isDefault).toBe(true);
  });

  it("should list models when available", async () => {
    if (codexProvider.listModels) {
      const models = await codexProvider.listModels();
      expect(models).toEqual([
        { id: "gpt-4o", name: "gpt-4o" },
        { id: "gpt-4.1", name: "gpt-4.1" },
      ]);
    }
  });

  it("treats whitespace-only API keys as unconfigured when starting a run", async () => {
    vi.mocked(getApiKey).mockReturnValue("   ");

    await expect(codexProvider.run(makeParams())).rejects.toThrow("OpenAI API key not configured");
  });

  it("skips model fetching when the API key is whitespace only", async () => {
    vi.mocked(getApiKey).mockReturnValue("   ");
    const fetchSpy = vi.fn();
    _setFetchForTests(fetchSpy as unknown as typeof fetch);

    if (codexProvider.listModels) {
      await expect(codexProvider.listModels()).resolves.toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("should list agents with project path", async () => {
    if (codexProvider.listAgents) {
      const agents = await codexProvider.listAgents("/project");
      expect(Array.isArray(agents)).toBe(true);
    }
  });

  it("should probe successfully with valid API key", async () => {
    if (codexProvider.probe) {
      const probeResult = await codexProvider.probe();
      expect(probeResult).toMatchObject({ ok: true });
      expect(probeResult.durationMs).toEqual(expect.any(Number));
    }
  });

  it("reports whitespace-only API keys as not configured during probe", async () => {
    vi.mocked(getApiKey).mockReturnValue("   ");
    const fetchSpy = vi.fn();
    _setFetchForTests(fetchSpy as unknown as typeof fetch);

    if (codexProvider.probe) {
      await expect(codexProvider.probe({ force: true })).resolves.toMatchObject({
        ok: false,
        reason: "OpenAI API key not configured",
        durationMs: 0,
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    }
  });

  it("should cache probe results until force is requested", async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-4o" }] }),
    });
    _setFetchForTests(fetchSpy as unknown as typeof fetch);

    if (codexProvider.probe) {
      await codexProvider.probe();
      await codexProvider.probe();
      await codexProvider.probe({ force: true });

      expect(fetchSpy).toHaveBeenCalledTimes(2);
    }
  });

  it("should stop gracefully", async () => {
    if (codexProvider.stop) {
      await expect(codexProvider.stop()).resolves.toBeUndefined();
    }
  });
});
