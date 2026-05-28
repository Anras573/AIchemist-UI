// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as CH from "../ipc-channels";

const ollamaMocks = vi.hoisted(() => ({
  list: vi.fn(),
  chat: vi.fn(),
  ctor: vi.fn(),
}));

vi.mock("ollama", () => ({
  default: {
    list: ollamaMocks.list,
    chat: ollamaMocks.chat,
  },
  Ollama: ollamaMocks.ctor,
}));

import {
  _resetOllamaClientForTests,
  getOllamaModels,
  OLLAMA_NO_MODELS_ERROR,
  runOllamaAgentTurn,
} from "./ollama";

function makeDb(rows: Array<{ id: string; role: string; content: string }>) {
  return {
    prepare: vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue(rows),
    }),
  };
}

function streamChunks(chunks: Array<{ message?: { content?: string } }>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("ollama provider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetOllamaClientForTests();
    delete process.env.OLLAMA_HOST;
    ollamaMocks.ctor.mockImplementation(function () {
      return {
        list: ollamaMocks.list,
        chat: ollamaMocks.chat,
      };
    });
  });

  it("runs a turn with filtered history and emits streaming deltas", async () => {
    const db = makeDb([
      { id: "m-placeholder", role: "user", content: "placeholder" },
      { id: "m-system", role: "system", content: "ignored" },
      { id: "m-user", role: "user", content: "hello" },
      { id: "m-assistant", role: "assistant", content: "hi" },
    ]);
    const send = vi.fn();
    ollamaMocks.chat.mockResolvedValue(
      streamChunks([{ message: { content: "Hel" } }, { message: { content: "" } }, { message: { content: "lo" } }])
    );

    const text = await runOllamaAgentTurn({
      db: db as never,
      sessionId: "s-1",
      messageId: "m-placeholder",
      projectConfig: { model: "qwen2.5:latest" } as never,
      webContents: { send } as never,
    } as never);

    expect(text).toBe("Hello");
    expect(ollamaMocks.chat).toHaveBeenCalledWith({
      model: "qwen2.5:latest",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      stream: true,
    });
    expect(send).toHaveBeenNthCalledWith(1, CH.SESSION_DELTA, {
      session_id: "s-1",
      text_delta: "Hel",
    });
    expect(send).toHaveBeenNthCalledWith(2, CH.SESSION_DELTA, {
      session_id: "s-1",
      text_delta: "lo",
    });
  });

  it("falls back to the first installed model when none is configured", async () => {
    const send = vi.fn();
    ollamaMocks.list.mockResolvedValue({
      models: [{ model: "phi4:latest" }, { model: "llama3.2" }],
    });
    ollamaMocks.chat.mockResolvedValue({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([]) as never,
        sessionId: "s-2",
        messageId: "m-2",
        projectConfig: { model: "" } as never,
        webContents: { send } as never,
      } as never)
    ).resolves.toBe("Done");

    expect(ollamaMocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "phi4:latest",
      })
    );
    expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, {
      session_id: "s-2",
      text_delta: "Done",
    });
  });

  it("throws a clear error when no configured or installed model is available", async () => {
    ollamaMocks.list.mockResolvedValue({ models: [] });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([]) as never,
        sessionId: "s-3",
        messageId: "m-3",
        projectConfig: {} as never,
        webContents: { send: vi.fn() } as never,
      } as never)
    ).rejects.toThrow(OLLAMA_NO_MODELS_ERROR);
  });

  it("constructs an Ollama client from OLLAMA_HOST and normalizes model IDs", async () => {
    process.env.OLLAMA_HOST = "  http://127.0.0.1:11434  ";
    const hostList = vi.fn().mockResolvedValue({
      models: [{ model: "mistral" }, { name: "phi3" }, { model: "   " }],
    });
    ollamaMocks.ctor.mockImplementation(function () {
      return {
        list: hostList,
        chat: vi.fn(),
      };
    });

    await expect(getOllamaModels()).resolves.toEqual([
      { id: "mistral", name: "mistral" },
      { id: "phi3", name: "phi3" },
    ]);
    expect(ollamaMocks.ctor).toHaveBeenCalledWith({
      host: "http://127.0.0.1:11434",
    });
    expect(hostList).toHaveBeenCalledTimes(1);
  });
});
