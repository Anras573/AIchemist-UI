// @vitest-environment node
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as CH from "../ipc-channels";

vi.mock("ollama", () => ({
  default: { list: vi.fn(), chat: vi.fn() },
  Ollama: vi.fn(),
}));

vi.mock("./mcp-bridge", () => ({
  createManagedMcpBridge: vi.fn(),
}));

import {
  _resetOllamaClientForTests,
  getOllamaModels,
  OLLAMA_NO_MODELS_ERROR,
  runOllamaAgentTurn,
} from "./ollama";
import { resolveApproval } from "./approval";

type OllamaMockState = {
  list: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>;
  ctor: ReturnType<typeof vi.fn>;
  bridge: ReturnType<typeof vi.fn>;
};

let ollamaMocks: OllamaMockState;
const tempDirs: string[] = [];

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".ollama-provider-"));
  tempDirs.push(dir);
  return dir;
}

async function loadMocks(): Promise<OllamaMockState> {
  const ollamaModule = await import("ollama");
  const bridgeModule = await import("./mcp-bridge");
  return {
    list: ollamaModule.default.list as OllamaMockState["list"],
    chat: ollamaModule.default.chat as OllamaMockState["chat"],
    ctor: ollamaModule.Ollama as OllamaMockState["ctor"],
    bridge: bridgeModule.createManagedMcpBridge as OllamaMockState["bridge"],
  };
}

function makeDb(
  rows: Array<{ id: string; role: string; content: string }>,
  onRun?: (sql: string, args: unknown[]) => void,
) {
  return {
    prepare: vi.fn().mockImplementation((sql: string) => ({
      all: vi.fn().mockReturnValue(sql.includes("FROM tool_calls") ? [] : rows),
      get: vi.fn().mockReturnValue(sql.includes("disabled_mcp_servers") ? { disabled_mcp_servers: null } : undefined),
      run: vi.fn().mockImplementation((...args: unknown[]) => {
        onRun?.(sql, args);
        return { changes: 1 };
      }),
    })),
  };
}

function streamChunks(chunks: Array<{ message?: { content?: string; tool_calls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }> } }>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("ollama provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    _resetOllamaClientForTests();
    delete process.env.OLLAMA_HOST;
    ollamaMocks = await loadMocks();
    ollamaMocks.bridge.mockResolvedValue({
      tools: [],
      hasTool: () => false,
      callTool: async () => "",
      close: async () => {},
    });
    ollamaMocks.ctor.mockImplementation(function () {
      return {
        list: ollamaMocks.list,
        chat: ollamaMocks.chat,
      };
    });
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
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
    expect(ollamaMocks.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "qwen2.5:latest",
        stream: true,
      }),
    );
    const call = ollamaMocks.chat.mock.calls[0][0];
    expect(call.messages).toEqual([
      expect.objectContaining({ role: "system" }),
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(call.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ function: expect.objectContaining({ name: "read_file" }) }),
    ]));
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

  it("rejects read_file for files above the preview cap", async () => {
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, "large.txt"), Buffer.alloc(512 * 1024 + 1, "a"));
    const send = vi.fn();
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "read_file", arguments: { path: "large.txt" } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "read the file" },
        ]) as never,
        sessionId: "s-5",
        messageId: "m-placeholder",
        projectPath,
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    const toolMessage = (ollamaMocks.chat.mock.calls[1][0].messages as Array<{ role: string; content: string; tool_name?: string }>)
      .find((message) => message.role === "tool" && message.tool_name === "read_file");
    expect(toolMessage?.content).toContain("File too large");
  });

  it("rejects read_file for symlinks that escape the project boundary", async () => {
    const projectPath = makeTempProject();
    const outsideDir = fs.mkdtempSync(path.join(process.cwd(), ".ollama-outside-"));
    tempDirs.push(outsideDir);
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "secret");
    fs.symlinkSync(outsideFile, path.join(projectPath, "secret.txt"));
    const send = vi.fn();
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "read_file", arguments: { path: "secret.txt" } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "read the file" },
        ]) as never,
        sessionId: "s-6",
        messageId: "m-placeholder",
        projectPath,
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    const toolMessage = (ollamaMocks.chat.mock.calls[1][0].messages as Array<{ role: string; content: string; tool_name?: string }>)
      .find((message) => message.role === "tool" && message.tool_name === "read_file");
    expect(toolMessage?.content).toContain("Path escapes project boundary");
  });

  it("rejects read_file for sensitive paths", async () => {
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, ".env.local"), "secret");
    const send = vi.fn();
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "read_file", arguments: { path: ".env.local" } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "read the file" },
        ]) as never,
        sessionId: "s-7",
        messageId: "m-placeholder",
        projectPath,
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    const toolMessage = (ollamaMocks.chat.mock.calls[1][0].messages as Array<{ role: string; content: string; tool_name?: string }>)
      .find((message) => message.role === "tool" && message.tool_name === "read_file");
    expect(toolMessage?.content).toContain("Access to sensitive path");
  });

  it("hides sensitive entries from list_directory", async () => {
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, ".env.local"), "secret");
    fs.mkdirSync(path.join(projectPath, ".git"));
    fs.mkdirSync(path.join(projectPath, "node_modules"));
    fs.writeFileSync(path.join(projectPath, "visible.txt"), "ok");
    const send = vi.fn();
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "list_directory", arguments: { path: "." } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "list the directory" },
        ]) as never,
        sessionId: "s-8",
        messageId: "m-placeholder",
        projectPath,
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    const toolMessage = (ollamaMocks.chat.mock.calls[1][0].messages as Array<{ role: string; content: string; tool_name?: string }>)
      .find((message) => message.role === "tool" && message.tool_name === "list_directory");
    expect(toolMessage).toBeDefined();
    const listing = JSON.parse(toolMessage!.content) as { entries: Array<{ name: string }> };
    expect(listing.entries.map((entry) => entry.name)).toEqual(["visible.txt"]);
  });

  it("skips sensitive files and directories in glob", async () => {
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, ".env.local"), "secret");
    fs.mkdirSync(path.join(projectPath, ".git"));
    fs.writeFileSync(path.join(projectPath, ".git", "config"), "secret");
    fs.mkdirSync(path.join(projectPath, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(projectPath, "node_modules", "pkg", "index.js"), "secret");
    fs.mkdirSync(path.join(projectPath, "src"));
    fs.writeFileSync(path.join(projectPath, "src", "keep.md"), "ok");
    fs.writeFileSync(path.join(projectPath, "visible.txt"), "ok");
    const send = vi.fn();
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: "glob", arguments: { pattern: "**/*" } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "glob the tree" },
        ]) as never,
        sessionId: "s-9",
        messageId: "m-placeholder",
        projectPath,
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    const toolMessage = (ollamaMocks.chat.mock.calls[1][0].messages as Array<{ role: string; content: string; tool_name?: string }>)
      .find((message) => message.role === "tool" && message.tool_name === "glob");
    expect(toolMessage).toBeDefined();
    const result = JSON.parse(toolMessage!.content) as { matches: string[] };
    expect(result.matches).toEqual(expect.arrayContaining([
      path.join(projectPath, "visible.txt"),
      path.join(projectPath, "src", "keep.md"),
    ]));
    expect(result.matches.join("\n")).not.toContain(".env.local");
    expect(result.matches.join("\n")).not.toContain(".git");
    expect(result.matches.join("\n")).not.toContain("node_modules");
  });

  it("routes managed MCP tools through the bridge", async () => {
    let recordedCategory: string | undefined;
    const db = makeDb([
      { id: "m-placeholder", role: "user", content: "placeholder" },
      { id: "m-user", role: "user", content: "use the tool" },
    ], (sql, args) => {
      if (sql.includes("INSERT INTO tool_calls")) {
        recordedCategory = String(args[5] ?? "");
      }
    });
    const send = vi.fn();
    const toolName = "mcp__context7__lookup__abcdef12";
    const callTool = vi.fn().mockResolvedValue("bridge result");
    ollamaMocks.bridge.mockResolvedValue({
      tools: [
        {
          type: "function",
          function: {
            name: toolName,
            description: "context7 — lookup — Search docs",
            parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
          },
        },
      ],
      hasTool: (name: string) => name === toolName,
      callTool,
      close: async () => {},
    });
    send.mockImplementation((channel: string, payload: { approval_id?: string }) => {
      if (channel === CH.SESSION_APPROVAL_REQUIRED && payload.approval_id) {
        resolveApproval(payload.approval_id, true);
      }
    });
    ollamaMocks.chat
      .mockResolvedValueOnce(
        streamChunks([
          {
            message: {
              content: "",
              tool_calls: [{ function: { name: toolName, arguments: { query: "needle" } } }],
            },
          },
        ]),
      )
      .mockResolvedValueOnce({ message: { content: "Done" } });

    await expect(
      runOllamaAgentTurn({
        db: db as never,
        sessionId: "s-4",
        messageId: "m-placeholder",
        projectConfig: {
          model: "qwen2.5:latest",
          approval_mode: "custom",
          approval_rules: [{ tool_category: "filesystem", policy: "never" }],
        } as never,
        webContents: { send } as never,
      } as never),
    ).resolves.toBe("Done");

    expect(ollamaMocks.bridge).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith("mcp__context7__lookup__abcdef12", { query: "needle" });
    expect(send).toHaveBeenCalledWith(CH.SESSION_APPROVAL_REQUIRED, expect.objectContaining({ tool_name: toolName }));
    expect(recordedCategory).toBe("shell");
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({ tool_name: toolName }));
    expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({ tool_name: toolName, output: "bridge result" }));
  });
});
