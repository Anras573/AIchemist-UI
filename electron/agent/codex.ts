import type { AgentInfo } from "../../src/types/index";
import { getApiKey } from "../config";
import { TurnEmitter } from "./turn-emitter";
import { providerSessionStore } from "./provider-session-store";
import { buildSkillsContext } from "./skills";
import { buildMemoryContext } from "./memory";
import { readAgentFileSystemPrompt } from "./claude";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Codex SDK types (based on @openai/codex-sdk interface) ────────────────────

interface CodexThread {
  id: string;
  created_at: number;
  metadata?: Record<string, unknown>;
}

interface CodexMessage {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: Array<{ type: string; text?: string }>;
  created_at: number;
}

interface CodexStreamEvent {
  event?: string;
  data?: {
    id?: string;
    delta?: {
      content?: Array<{
        type: string;
        text?: string;
      }>;
    };
    usage?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    };
  };
}

interface CodexClient {
  threads: {
    create(): Promise<CodexThread>;
    retrieve(threadId: string): Promise<CodexThread>;
  };
  messages: {
    create(
      threadId: string,
      options: { role: "user" | "assistant"; content: string }
    ): Promise<CodexMessage>;
  };
  runs: {
    stream(
      threadId: string,
      options: {
        assistant_id?: string;
        model?: string;
        instructions?: string;
      }
    ): AsyncIterable<CodexStreamEvent>;
  };
}

// ── Session state extension for Codex ──────────────────────────────────────────

export interface CodexSessionState {
  threadId?: string | null;
}

// ── Singleton client ──────────────────────────────────────────────────────────

let clientInstance: CodexClient | null = null;
const OPENAI_API_BASE_URL = "https://api.openai.com/v1";

async function getClient(): Promise<CodexClient> {
  if (clientInstance) return clientInstance;

  const apiKey = getApiKey("openai") ?? undefined;
  if (!apiKey) {
    throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY in ~/.aichemist/.env");
  }

  // Lazy load OpenAI SDK
  const { default: OpenAI } = await import("openai");
  const openaiClient = new OpenAI({ apiKey, baseURL: OPENAI_API_BASE_URL });

  // Adapt OpenAI SDK to our Codex interface
  clientInstance = {
    threads: {
      create: async () => {
        const thread = await openaiClient.beta.threads.create();
        return { id: thread.id, created_at: thread.created_at };
      },
      retrieve: async (threadId: string) => {
        const thread = await openaiClient.beta.threads.retrieve(threadId);
        return { id: thread.id, created_at: thread.created_at };
      },
    },
    messages: {
      create: async (threadId: string, options: any) => {
        const msg = await openaiClient.beta.threads.messages.create(threadId, options);
        return {
          id: msg.id,
          thread_id: msg.thread_id,
          role: msg.role as "user" | "assistant",
          content: msg.content.map((c: any) => ({
            type: c.type,
            text: c.type === "text" ? c.text : undefined,
          })),
          created_at: msg.created_at,
        };
      },
    },
    runs: {
      stream: async function* (threadId: string, options: any) {
        const stream = await openaiClient.beta.threads.runs.stream(threadId, options);
        for await (const event of stream) {
          yield event as any;
        }
      },
    },
  };

  return clientInstance;
}

// ── Model listing ─────────────────────────────────────────────────────────────

async function listCodexModels(): Promise<Array<{ id: string; name: string }>> {
  try {
    const apiKey = getApiKey("openai");
    if (!apiKey) return [];

    const response = await fetch(`${OPENAI_API_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) return [];

    const data = (await response.json()) as { data: Array<{ id: string; owned_by?: string }> };
    return data.data
      .filter((m) => m.id.includes("gpt-4") || m.id.includes("gpt-3.5"))
      .map((m) => ({ id: m.id, name: m.id }));
  } catch {
    return [];
  }
}

// ── Provider implementation ────────────────────────────────────────────────────

export const codexProvider: AgentProvider = {
  async run(params: AgentProviderParams): Promise<string> {
    const {
      db,
      sessionId,
      prompt,
      projectPath,
      webContents,
      skills,
      agent,
    } = params;

    const emitter = new TurnEmitter(webContents, sessionId);

    try {
      const client = await getClient();

      // Resolve or create thread
      let threadId: string;
      const prior = providerSessionStore.get(db, sessionId, "codex") as CodexSessionState | null;
      const resumeId = prior?.threadId ?? null;

      if (!resumeId) {
        const thread = await client.threads.create();
        threadId = thread.id;
      } else {
        // Verify thread still exists
        try {
          const thread = await client.threads.retrieve(resumeId);
          threadId = thread.id;
        } catch {
          // Thread not found, create a new one
          const thread = await client.threads.create();
          threadId = thread.id;
        }
      }

      // Build system prompt
      const systemPrompt = buildSystemPrompt(projectPath, skills, agent);

      // Add user message
      await client.messages.create(threadId, {
        role: "user",
        content: prompt,
      });

      // Stream the run
      let fullText = "";
      for await (const event of client.runs.stream(threadId, {
        model: "gpt-4",
        instructions: systemPrompt,
      })) {
        if (event.event === "thread.message.delta" && event.data?.delta?.content) {
          for (const content of event.data.delta.content) {
            if (content.type === "text" && content.text) {
              fullText += content.text;
              emitter.delta(content.text);
            }
          }
        }

        if (event.event === "thread.run.completed" && event.data?.usage) {
          const usage = event.data.usage;
          emitter.usage({
            input_tokens: usage.prompt_tokens,
            output_tokens: usage.completion_tokens,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          });
        }
      }

      // Persist thread ID for resume
      providerSessionStore.set(db, sessionId, "codex", {
        threadId: threadId || null,
      });

      return fullText;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      emitter.delta(`Error: ${message}`);
      throw error;
    }
  },

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return listCodexModels();
  },

  async listAgents(): Promise<AgentInfo[]> {
    // Codex does not have agents like Claude/Copilot
    return [];
  },

  async probe(): Promise<{ ok: boolean; reason?: string }> {
    try {
      const apiKey = getApiKey("openai");
      if (!apiKey) {
        return {
          ok: false,
          reason: "OpenAI API key not configured",
        };
      }

      // Quick connectivity check with timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      try {
        const response = await fetch(`${OPENAI_API_BASE_URL}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          return { ok: true };
        }

        if (response.status === 401 || response.status === 403) {
          return { ok: false, reason: "Invalid OpenAI API key" };
        }

        return { ok: false, reason: `OpenAI API error: ${response.status}` };
      } catch (error) {
        clearTimeout(timeout);
        if (error instanceof Error && error.name === "AbortError") {
          return { ok: false, reason: "OpenAI API timeout" };
        }
        return { ok: false, reason: String(error) };
      }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "Unknown error",
      };
    }
  },

  async stop(): Promise<void> {
    clientInstance = null;
    providerSessionStore.reset();
  },
};

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the system prompt for Codex by combining project instructions,
 * agent body (if selected), skills context, and memory context.
 */
function buildSystemPrompt(
  projectPath: string,
  skills?: string[],
  agent?: string
): string {
  const parts: string[] = [
    "You are AIchemist, a coding assistant running inside a desktop app.",
    "Use the available tools to inspect and modify the project, run commands, and fetch URLs.",
  ];

  // Add agent system prompt if selected
  if (agent) {
    try {
      const result = readAgentFileSystemPrompt(agent);
      if (result) {
        parts.push(result.body);
      }
    } catch {
      // Agent not found, skip
    }
  }

  // Add skills context
  if (skills && skills.length > 0) {
    try {
      const skillsContext = buildSkillsContext(skills, projectPath);
      if (skillsContext) {
        parts.push("Available skills and capabilities:");
        parts.push(skillsContext);
      }
    } catch {
      // Skill loading error, skip
    }
  }

  // Add memory context
  try {
    const memoryContext = buildMemoryContext(projectPath);
    if (memoryContext) {
      parts.push("Persistent project memory:");
      parts.push(memoryContext);
    }
  } catch {
    // Memory loading error, skip
  }

  return parts.join("\n\n");
}

// Test seams for mocking
export function _setClientForTests(client: CodexClient | null): void {
  clientInstance = client;
}
