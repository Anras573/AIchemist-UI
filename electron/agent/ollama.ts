import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import type { AgentProvider, AgentProviderParams } from "./provider";

type ChatRole = "system" | "user" | "assistant";

interface OllamaMessage {
  role: ChatRole;
  content: string;
}

interface OllamaModel {
  model?: string;
  name?: string;
}

interface OllamaListResult {
  models?: OllamaModel[];
}

interface OllamaChatChunk {
  message?: { content?: string };
}

interface OllamaClientLike {
  list(): Promise<OllamaListResult>;
  chat(input: {
    model: string;
    messages: OllamaMessage[];
    stream?: boolean;
  }): Promise<AsyncIterable<OllamaChatChunk> | { message?: { content?: string } }>;
}

function isAsyncIterable<T>(value: unknown): value is AsyncIterable<T> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

let clientPromise: Promise<OllamaClientLike> | null = null;

async function loadClient(): Promise<OllamaClientLike> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const mod = await import("ollama");
    const host = process.env.OLLAMA_HOST?.trim();
    if (host && typeof mod.Ollama === "function") {
      return new mod.Ollama({ host }) as OllamaClientLike;
    }
    return (mod.default ?? mod) as unknown as OllamaClientLike;
  })();
  return clientPromise;
}

function loadHistory(db: Database, sessionId: string, placeholderMessageId: string): OllamaMessage[] {
  const rows = db
    .prepare(
      `SELECT id, role, content
       FROM messages
       WHERE session_id = ?
       ORDER BY created_at ASC`
    )
    .all(sessionId) as Array<{ id: string; role: string; content: string }>;

  return rows
    .filter((row) => row.id !== placeholderMessageId)
    .filter((row) => row.role === "user" || row.role === "assistant")
    .map((row) => ({
      role: row.role as "user" | "assistant",
      content: row.content,
    }));
}

async function runOllamaAgentTurn(params: AgentProviderParams): Promise<string> {
  const client = await loadClient();
  const history = loadHistory(params.db, params.sessionId, params.messageId);
  const model = await resolveModel(client, params.projectConfig.model);

  const response = await client.chat({
    model,
    messages: history,
    stream: true,
  });

  let fullText = "";
  if (isAsyncIterable<OllamaChatChunk>(response)) {
    for await (const chunk of response) {
      const delta = chunk?.message?.content ?? "";
      if (!delta) continue;
      fullText += delta;
      params.webContents.send(CH.SESSION_DELTA, {
        session_id: params.sessionId,
        text_delta: delta,
      });
    }
    return fullText;
  }

  const text = response?.message?.content ?? "";
  if (text) {
    params.webContents.send(CH.SESSION_DELTA, {
      session_id: params.sessionId,
      text_delta: text,
    });
  }
  return text;
}

async function listModels(client: OllamaClientLike): Promise<Array<{ id: string; name: string }>> {
  const list = await client.list();
  return (list.models ?? [])
    .map((m) => {
      const id = (m.model ?? m.name ?? "").trim();
      const name = id;
      return id ? { id, name } : null;
    })
    .filter((m): m is { id: string; name: string } => m !== null);
}

async function resolveModel(client: OllamaClientLike, configuredModel?: string): Promise<string> {
  const explicit = configuredModel?.trim();
  if (explicit) return explicit;
  const discovered = await listModels(client);
  const fallback = discovered[0]?.id;
  if (fallback) return fallback;
  throw new Error("No Ollama model configured or installed. Set a model in Project Settings or run `ollama pull <model>`.");
}

export async function getOllamaModels(): Promise<Array<{ id: string; name: string }>> {
  const client = await loadClient();
  return listModels(client);
}

export const ollamaProvider: AgentProvider = {
  run: (params: AgentProviderParams) => runOllamaAgentTurn(params),
  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return getOllamaModels();
  },
};
