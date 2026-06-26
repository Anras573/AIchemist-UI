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

describe("codexProvider", () => {
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
    const webContents = {
      send: vi.fn(),
    } as any;

    const params: AgentProviderParams = {
      db: mockDb,
      sessionId: "session-123",
      messageId: "msg-123",
      prompt: "Hello, Codex!",
      projectPath: "/project",
      projectConfig: {
        provider: "codex",
        model: "gpt-4",
      } as any, // Cast to any to avoid strict type checking
      webContents,
      skills: [],
      agent: undefined,
      noTools: false,
      nonInteractive: false,
    };

    const result = await codexProvider.run(params);

    expect(result).toBe("Hello Codex");
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
