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
import { codexProvider, _setClientForTests, _setFetchForTests } from "./codex";
import { providerSessionStore } from "./provider-session-store";

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
    _setClientForTests(null); // Reset client singleton
    _setFetchForTests(
      vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ data: [{ id: "gpt-4o" }, { id: "gpt-4.1" }] }),
      }) as unknown as typeof fetch,
    );
  });

  afterEach(() => {
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

  it("should list agents with project path", async () => {
    if (codexProvider.listAgents) {
      const agents = await codexProvider.listAgents("/project");
      expect(Array.isArray(agents)).toBe(true);
    }
  });

  it("should probe successfully with valid API key", async () => {
    if (codexProvider.probe) {
      const probeResult = await codexProvider.probe();
      expect(probeResult).toEqual({ ok: true });
    }
  });

  it("should stop gracefully", async () => {
    if (codexProvider.stop) {
      await expect(codexProvider.stop()).resolves.toBeUndefined();
    }
  });
});
