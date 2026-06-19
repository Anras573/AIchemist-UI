// @vitest-environment node
import * as fs from "fs";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as CH from "../ipc-channels";

vi.mock("ollama", () => ({
  default: { list: vi.fn(), chat: vi.fn(), show: vi.fn() },
  Ollama: vi.fn(),
}));

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
  _resetOllamaClientForTests,
  getOllamaModels,
  OLLAMA_NO_MODELS_ERROR,
  runOllamaAgentTurn,
} from "./ollama";
import { resolveApproval } from "./approval";
import { _setNativeTracesRootForTests } from "../native-transcript";

type OllamaMockState = {
  list: ReturnType<typeof vi.fn>;
  chat: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  ctor: ReturnType<typeof vi.fn>;
  bridge: ReturnType<typeof vi.fn>;
};

let ollamaMocks: OllamaMockState;
const tempDirs: string[] = [];

// Creating a file symlink on Windows requires elevation or Developer Mode, so
// fs.symlinkSync throws EPERM in ordinary CI. The boundary check itself works on
// Windows (it relies on fs.realpathSync) — we just can't set up the fixture.
const itSymlink = process.platform === "win32" ? it.skip : it;

function makeTempProject(): string {
  const dir = fs.mkdtempSync(path.join(process.cwd(), ".ollama-provider-"));
  tempDirs.push(dir);
  return dir;
}

async function loadMocks(): Promise<OllamaMockState> {
  const ollamaModule = await import("ollama");
  const bridgeModule = await import("../mcp/approval");
  return {
    list: ollamaModule.default.list as OllamaMockState["list"],
    chat: ollamaModule.default.chat as OllamaMockState["chat"],
    show: ollamaModule.default.show as OllamaMockState["show"],
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

function streamChunks(chunks: Array<{ message?: { content?: string; thinking?: string; tool_calls?: Array<{ function: { name: string; arguments?: Record<string, unknown> } }> } }>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("ollama provider", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    settingsMock.maxToolRounds = 8;
    agentFileMock.result = null;
    _resetOllamaClientForTests();
    const tracesDir = fs.mkdtempSync(path.join(process.cwd(), ".ollama-traces-"));
    tempDirs.push(tracesDir);
    _setNativeTracesRootForTests(tracesDir);
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
    _setNativeTracesRootForTests(null);
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

  it("appends the prompt when it is not already the last user message (skipPersistence turns)", async () => {
    // PR draft generation sends a prompt that is never saved to the DB —
    // the turn must still see it as the final user message.
    const db = makeDb([
      { id: "m-user", role: "user", content: "hello" },
      { id: "m-assistant", role: "assistant", content: "hi" },
    ]);
    ollamaMocks.chat.mockResolvedValue({ message: { content: "Draft" } });

    await runOllamaAgentTurn({
      db: db as never,
      sessionId: "s-pr",
      messageId: "m-placeholder",
      prompt: "Draft a PR description",
      projectConfig: { model: "qwen2.5:latest" } as never,
      webContents: { send: vi.fn() } as never,
      noTools: true,
    } as never);

    const call = ollamaMocks.chat.mock.calls[0][0];
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: "user",
      content: "Draft a PR description",
    });
  });

  it("replaces the last user message with the augmented prompt (issue context)", async () => {
    const db = makeDb([
      { id: "m-user", role: "user", content: "fix the bug" },
    ]);
    ollamaMocks.chat.mockResolvedValue({ message: { content: "ok" } });

    await runOllamaAgentTurn({
      db: db as never,
      sessionId: "s-issue",
      messageId: "m-placeholder",
      prompt: "GitHub Issue #7: crash on save\n\n---\n\nfix the bug",
      projectConfig: { model: "qwen2.5:latest" } as never,
      webContents: { send: vi.fn() } as never,
    } as never);

    const call = ollamaMocks.chat.mock.calls[0][0];
    const userMessages = call.messages.filter((m: { role: string }) => m.role === "user");
    expect(userMessages).toEqual([
      { role: "user", content: "GitHub Issue #7: crash on save\n\n---\n\nfix the bug" },
    ]);
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

  itSymlink("rejects read_file for symlinks that escape the project boundary", async () => {
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

  it("surfaces a truncation notice (and keeps partial text) when the tool-round cap is hit", async () => {
    settingsMock.maxToolRounds = 1;
    const projectPath = makeTempProject();
    fs.writeFileSync(path.join(projectPath, "notes.txt"), "content");
    const db = makeDb([
      { id: "m-placeholder", role: "user", content: "placeholder" },
      { id: "m-user", role: "user", content: "keep going" },
    ]);
    const send = vi.fn();
    // The model keeps asking for tools; with the cap at 1 the loop stops after
    // the first round instead of looping forever.
    ollamaMocks.chat.mockResolvedValue(
      streamChunks([
        {
          message: {
            content: "working",
            tool_calls: [{ function: { name: "read_file", arguments: { path: "notes.txt" } } }],
          },
        },
      ]),
    );

    const text = await runOllamaAgentTurn({
      db: db as never,
      sessionId: "s-cap",
      messageId: "m-placeholder",
      projectPath,
      projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
      webContents: { send } as never,
    } as never);

    // Exactly one chat round ran before the cap stopped the loop.
    expect(ollamaMocks.chat).toHaveBeenCalledTimes(1);
    expect(text).toContain("working");
    expect(text).toContain("Reached the tool-round limit (1)");
    expect(send).toHaveBeenCalledWith(
      CH.SESSION_DELTA,
      expect.objectContaining({
        session_id: "s-cap",
        text_delta: expect.stringContaining("Reached the tool-round limit (1)"),
      }),
    );
  });

  it("rejects provider tool calls when noTools is enabled", async () => {
    ollamaMocks.chat.mockResolvedValue(streamChunks([
      {
        message: {
          content: "",
          tool_calls: [{ function: { name: "read_file", arguments: { path: "secret.txt" } } }],
        },
      },
    ]));

    await expect(
      runOllamaAgentTurn({
        db: makeDb([]) as never,
        sessionId: "s-no-tools",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest" } as never,
        webContents: { send: vi.fn() } as never,
        noTools: true,
      } as never),
    ).rejects.toThrow("tools are disabled");

    expect(ollamaMocks.bridge).not.toHaveBeenCalled();
  });

  describe("delegate_task tool", () => {
    it("delegates a sub-task to another installed model and returns its response", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "codellama" }] });
      ollamaMocks.chat
        // Orchestrator turn: calls delegate_task
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "codellama", prompt: "Write a hello world in Python" } } }],
              },
            },
          ]),
        )
        // Sub-agent turn: returns a plain text response
        .mockResolvedValueOnce({ message: { content: "print('Hello, world!')" } })
        // Orchestrator second round: produces final reply
        .mockResolvedValueOnce({ message: { content: "Here is the result from codellama." } });

      const text = await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate to codellama" },
        ]) as never,
        sessionId: "s-delegate",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(text).toBe("Here is the result from codellama.");
      // Sub-agent should have been called with the delegated model
      const subAgentCall = ollamaMocks.chat.mock.calls[1][0];
      expect(subAgentCall.model).toBe("codellama");
      expect(subAgentCall.messages[0].role).toBe("system");
      expect(subAgentCall.messages[1]).toEqual({ role: "user", content: "Write a hello world in Python" });
      // Sub-agent must not have ask_user but must have delegate_task (depth guard enforces the limit)
      const subToolNames = subAgentCall.tools.map((t: { function: { name: string } }) => t.function.name);
      expect(subToolNames).not.toContain("ask_user");
      expect(subToolNames).toContain("delegate_task");
      // delegate_task tool call should be recorded in IPC events
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({ tool_name: "delegate_task" }));
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "delegate_task",
        output: "print('Hello, world!')",
      }));
    });

    it("returns an error when the requested model is not installed", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "notinstalled", prompt: "do something" } } }],
              },
            },
          ]),
        )
        .mockResolvedValueOnce({ message: { content: "Got the error." } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-delegate-missing",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "delegate_task",
        output: expect.stringContaining('model "notinstalled" is not installed'),
      }));
    });

    it("resolves tagged→untagged: 'codellama:latest' matches installed 'codellama'", async () => {
      const send = vi.fn();
      // ollama list returns untagged "codellama"; orchestrator requests "codellama:latest"
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "codellama" }] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "codellama:latest", prompt: "hello" } } }],
              },
            },
          ]),
        )
        // Sub-agent (resolved to "codellama") returns plain text
        .mockResolvedValueOnce({ message: { content: "sub result" } })
        // Orchestrator final reply
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-tag-strip",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // Sub-agent chat call must use the untagged id that was actually installed
      expect(ollamaMocks.chat.mock.calls[1][0].model).toBe("codellama");
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "delegate_task",
        output: "sub result",
      }));
    });

    it("resolves untagged request to a non-:latest installed variant (e.g. 'codellama' → 'codellama:13b')", async () => {
      const send = vi.fn();
      // Only codellama:13b is installed — no :latest variant
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "codellama:13b" }] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "codellama", prompt: "hello" } } }],
              },
            },
          ]),
        )
        .mockResolvedValueOnce({ message: { content: "sub result" } })
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-tag-fallback",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(ollamaMocks.chat.mock.calls[1][0].model).toBe("codellama:13b");
    });

    it("prefers :latest over untagged exact match when both are installed", async () => {
      const send = vi.fn();
      // Both "codellama" (untagged) and "codellama:latest" are installed
      ollamaMocks.list.mockResolvedValue({
        models: [{ model: "qwen2.5:latest" }, { model: "codellama" }, { model: "codellama:latest" }],
      });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "codellama", prompt: "hello" } } }],
              },
            },
          ]),
        )
        .mockResolvedValueOnce({ message: { content: "sub result" } })
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-prefer-latest",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(ollamaMocks.chat.mock.calls[1][0].model).toBe("codellama:latest");
    });

    it("excludes ask_user from the sub-agent tool list", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "phi4" }] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "sub-task" } } }],
              },
            },
          ]),
        )
        .mockResolvedValueOnce({ message: { content: "phi4 response" } })
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-no-ask-user",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      const subAgentCall = ollamaMocks.chat.mock.calls[1][0];
      const subToolNames = subAgentCall.tools.map((t: { function: { name: string } }) => t.function.name);
      expect(subToolNames).not.toContain("ask_user");
      expect(subToolNames).toContain("delegate_task");
    });

    it("blocks delegation at MAX_DELEGATION_DEPTH via the depth guard, emitting IPC events for the error", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "phi4" }] });
      ollamaMocks.chat
        // Orchestrator (depth 0) → delegate_task("phi4", "level-1 task")
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "level-1 task" } } }],
              },
            },
          ]),
        )
        // phi4 sub-agent (depth 1) → tries to delegate further, depth guard fires inside runTool
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "level-2 task" } } }],
              },
            },
          ]),
        )
        // phi4 (depth 1) gets the depth-limit error as a tool result, produces final text
        .mockResolvedValueOnce({ message: { content: "phi4 finished with depth error" } })
        // Orchestrator (depth 0) gets phi4's response as tool result, produces final text
        .mockResolvedValueOnce({ message: { content: "done" } });

      const text = await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-depth-guard",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(text).toBe("done");
      // 4 chat calls: orchestrator round 1, phi4 round 1, phi4 round 2 (after error), orchestrator round 2
      expect(ollamaMocks.chat).toHaveBeenCalledTimes(4);
      // The depth-guard error must appear in IPC as a normal tool result (not a silent early return)
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({
        tool_name: "delegate_task",
        input: expect.objectContaining({ model: "phi4", prompt: "level-2 task" }),
      }));
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "delegate_task",
        output: expect.stringContaining("depth limit"),
      }));
    });

    it("hard-blocks ask_user in a delegated turn via a guard in executeTool, emitting IPC events", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "phi4" }] });
      ollamaMocks.chat
        // Orchestrator → delegate_task("phi4", "sub-task")
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "ask something" } } }],
              },
            },
          ]),
        )
        // phi4 (depth 1) emits ask_user even though it isn't in its tool list
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "ask_user", arguments: { question: "What colour?" } } }],
              },
            },
          ]),
        )
        // phi4 gets the hard-block error, produces final text
        .mockResolvedValueOnce({ message: { content: "phi4 done" } })
        // Orchestrator final
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-ask-user-guard",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // The ask_user call inside the delegated turn must be blocked and surfaced via IPC
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({ tool_name: "ask_user" }));
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "ask_user",
        output: expect.stringContaining("not available in delegated turns"),
      }));
      // requestQuestion must NOT have been called (the real question flow is bypassed)
      expect(send).not.toHaveBeenCalledWith(CH.SESSION_QUESTION_REQUIRED, expect.anything());
    });

    it("suppresses SESSION_DELTA from the sub-agent so its text does not interleave with the orchestrator output", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "phi4" }] });
      ollamaMocks.chat
        // Orchestrator: emits text then calls delegate_task
        .mockResolvedValueOnce(
          streamChunks([
            { message: { content: "orchestrator prefix " } },
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "sub-task" } } }],
              },
            },
          ]),
        )
        // Sub-agent (phi4) streams text — should be suppressed
        .mockResolvedValueOnce(
          streamChunks([
            { message: { content: "sub-agent text" } },
          ]),
        )
        // Orchestrator final round
        .mockResolvedValueOnce(
          streamChunks([
            { message: { content: "orchestrator final" } },
          ]),
        );

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-delta-suppress",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // Orchestrator text is forwarded
      expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, expect.objectContaining({ text_delta: "orchestrator prefix " }));
      expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, expect.objectContaining({ text_delta: "orchestrator final" }));
      // Sub-agent text is suppressed
      expect(send).not.toHaveBeenCalledWith(CH.SESSION_DELTA, expect.objectContaining({ text_delta: "sub-agent text" }));
    });

    it("routes unknown/MCP tool calls from a sub-agent through runTool so they appear in the timeline", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "phi4" }] });
      ollamaMocks.chat
        // Orchestrator → delegate_task("phi4", "sub-task")
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "do work" } } }],
              },
            },
          ]),
        )
        // phi4 calls an MCP tool that the noop bridge doesn't know about
        .mockResolvedValueOnce(
          streamChunks([
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "mcp__context7__lookup", arguments: { query: "needle" } } }],
              },
            },
          ]),
        )
        // phi4 gets the "unsupported" error, produces final text
        .mockResolvedValueOnce({ message: { content: "phi4 done" } })
        // Orchestrator final
        .mockResolvedValueOnce({ message: { content: "done" } });

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-mcp-noop",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // The MCP call must be visible in the UI timeline via proper IPC events
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_CALL, expect.objectContaining({
        tool_name: "mcp__context7__lookup",
      }));
      expect(send).toHaveBeenCalledWith(CH.SESSION_TOOL_RESULT, expect.objectContaining({
        tool_name: "mcp__context7__lookup",
        output: expect.stringContaining("Unsupported tool"),
      }));
    });
  });

  describe("agent model override", () => {
    it("uses the agent's model: frontmatter, honoring untagged → :latest matching", async () => {
      agentFileMock.result = { body: "be terse", model: "codellama" };
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }, { model: "codellama:latest" }] });
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hi" },
        ]) as never,
        sessionId: "s-agent-model",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
        agent: "coder",
      } as never);

      // The agent override resolves the untagged "codellama" to the installed
      // "codellama:latest", overriding the project model "qwen2.5:latest".
      expect(ollamaMocks.chat.mock.calls[0][0].model).toBe("codellama:latest");
    });

    it("falls back to the project model when the agent omits a model", async () => {
      agentFileMock.result = { body: "be terse" };
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hi" },
        ]) as never,
        sessionId: "s-agent-no-model",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
        agent: "coder",
      } as never);

      expect(ollamaMocks.chat.mock.calls[0][0].model).toBe("qwen2.5:latest");
      // No model override means we never need to list installed models.
      expect(ollamaMocks.list).not.toHaveBeenCalled();
    });

    it("warns and falls back to the project model when the agent model is not installed", async () => {
      agentFileMock.result = { body: "be terse", model: "not-installed" };
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen2.5:latest" }] });
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hi" },
        ]) as never,
        sessionId: "s-agent-bad-model",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send: vi.fn() } as never,
        agent: "coder",
      } as never);

      expect(ollamaMocks.chat.mock.calls[0][0].model).toBe("qwen2.5:latest");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not-installed"));
      warn.mockRestore();
    });
  });

  describe("extended thinking / reasoning", () => {
    it("requests thinking and streams reasoning deltas for a thinking-capable model", async () => {
      const send = vi.fn();
      ollamaMocks.show.mockResolvedValue({ capabilities: ["completion", "tools", "thinking"] });
      ollamaMocks.chat.mockResolvedValue(
        streamChunks([
          { message: { thinking: "Let me " } },
          { message: { thinking: "reason." } },
          { message: { content: "Answer." } },
        ]),
      );

      const text = await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "think hard" },
        ]) as never,
        sessionId: "s-think",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(text).toBe("Answer.");
      expect(ollamaMocks.show).toHaveBeenCalledWith({ model: "qwen3:latest" });
      expect(ollamaMocks.chat).toHaveBeenCalledWith(expect.objectContaining({ think: true }));
      // Reasoning is streamed via the thinking channel, then closed when content arrives.
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, {
        session_id: "s-think",
        text_delta: "Let me ",
      });
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, {
        session_id: "s-think",
        text_delta: "reason.",
      });
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DONE, { session_id: "s-think" });
      expect(send).toHaveBeenCalledWith(CH.SESSION_DELTA, {
        session_id: "s-think",
        text_delta: "Answer.",
      });
    });

    it("does not request thinking (or emit reasoning) for a model without the thinking capability", async () => {
      const send = vi.fn();
      ollamaMocks.show.mockResolvedValue({ capabilities: ["completion", "tools"] });
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "Hi" } }]));

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hello" },
        ]) as never,
        sessionId: "s-no-think",
        messageId: "m-placeholder",
        projectConfig: { model: "llama3.2:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(ollamaMocks.chat.mock.calls[0][0].think).toBeUndefined();
      expect(send).not.toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, expect.anything());
      expect(send).not.toHaveBeenCalledWith(CH.SESSION_THINKING_DONE, expect.anything());
    });

    it("treats a failing capability probe as no-thinking instead of breaking the turn", async () => {
      const send = vi.fn();
      ollamaMocks.show.mockRejectedValue(new Error("show unsupported"));
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));

      const text = await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hello" },
        ]) as never,
        sessionId: "s-think-err",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen2.5:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      expect(text).toBe("ok");
      expect(ollamaMocks.chat.mock.calls[0][0].think).toBeUndefined();
      expect(send).not.toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, expect.anything());
    });

    it("closes the reasoning block at end of stream when thinking is followed by a tool call (no content)", async () => {
      const projectPath = makeTempProject();
      fs.writeFileSync(path.join(projectPath, "notes.txt"), "content");
      const send = vi.fn();
      ollamaMocks.show.mockResolvedValue({ capabilities: ["thinking", "tools"] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            { message: { thinking: "I should read the file." } },
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "read_file", arguments: { path: "notes.txt" } } }],
              },
            },
          ]),
        )
        .mockResolvedValueOnce(streamChunks([{ message: { content: "Done" } }]));

      await expect(
        runOllamaAgentTurn({
          db: makeDb([
            { id: "m-placeholder", role: "user", content: "placeholder" },
            { id: "m-user", role: "user", content: "read it" },
          ]) as never,
          sessionId: "s-think-tool",
          messageId: "m-placeholder",
          projectPath,
          projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
          webContents: { send } as never,
        } as never),
      ).resolves.toBe("Done");

      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, {
        session_id: "s-think-tool",
        text_delta: "I should read the file.",
      });
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DONE, { session_id: "s-think-tool" });
    });

    it("caches the capability probe per model across turns (one show() call for two turns)", async () => {
      const send = vi.fn();
      ollamaMocks.show.mockResolvedValue({ capabilities: ["thinking"] });
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));

      const runTurn = (sessionId: string) =>
        runOllamaAgentTurn({
          db: makeDb([
            { id: "m-placeholder", role: "user", content: "placeholder" },
            { id: "m-user", role: "user", content: "hi" },
          ]) as never,
          sessionId,
          messageId: "m-placeholder",
          projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
          webContents: { send } as never,
        } as never);

      // Two turns with the same model and NO cache reset in between — the
      // capability must be probed only once across both.
      await runTurn("s-think-cache-1");
      await runTurn("s-think-cache-2");

      expect(ollamaMocks.chat).toHaveBeenCalledTimes(2);
      // Both turns still request thinking…
      expect(ollamaMocks.chat.mock.calls.every((c) => c[0].think === true)).toBe(true);
      // …but the capability probe ran exactly once (the second turn hit the cache).
      expect(ollamaMocks.show).toHaveBeenCalledTimes(1);
    });

    it("re-probes on the next turn after a transient probe failure (does not cache errors)", async () => {
      const send = vi.fn();
      // First probe throws; second probe succeeds — thinking must come back on.
      ollamaMocks.show
        .mockRejectedValueOnce(new Error("server temporarily unavailable"))
        .mockResolvedValueOnce({ capabilities: ["thinking"] });
      ollamaMocks.chat.mockResolvedValue(streamChunks([{ message: { content: "ok" } }]));

      const runTurn = (sessionId: string) =>
        runOllamaAgentTurn({
          db: makeDb([
            { id: "m-placeholder", role: "user", content: "placeholder" },
            { id: "m-user", role: "user", content: "hi" },
          ]) as never,
          sessionId,
          messageId: "m-placeholder",
          projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
          webContents: { send } as never,
        } as never);

      await runTurn("s-think-retry-1");
      await runTurn("s-think-retry-2");

      // The failure was NOT cached, so the second turn probed again…
      expect(ollamaMocks.show).toHaveBeenCalledTimes(2);
      // …turn 1 had no thinking (probe failed), turn 2 enabled it (probe succeeded).
      expect(ollamaMocks.chat.mock.calls[0][0].think).toBeUndefined();
      expect(ollamaMocks.chat.mock.calls[1][0].think).toBe(true);
    });

    it("does not surface thinking from a delegated sub-agent even if the model emits it", async () => {
      const send = vi.fn();
      ollamaMocks.list.mockResolvedValue({ models: [{ model: "qwen3:latest" }, { model: "phi4" }] });
      // Orchestrator (think-capable) reasons, then delegates.
      ollamaMocks.show.mockResolvedValue({ capabilities: ["thinking"] });
      ollamaMocks.chat
        .mockResolvedValueOnce(
          streamChunks([
            { message: { thinking: "orchestrator reasoning" } },
            {
              message: {
                content: "",
                tool_calls: [{ function: { name: "delegate_task", arguments: { model: "phi4", prompt: "sub-task" } } }],
              },
            },
          ]),
        )
        // Sub-agent emits thinking despite think=false — it must be suppressed.
        .mockResolvedValueOnce(
          streamChunks([
            { message: { thinking: "sub-agent reasoning" } },
            { message: { content: "sub done" } },
          ]),
        )
        // Orchestrator final round.
        .mockResolvedValueOnce(streamChunks([{ message: { content: "done" } }]));

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "delegate" },
        ]) as never,
        sessionId: "s-sub-no-think",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // The sub-agent runs with think=false (no thinking requested)…
      expect(ollamaMocks.chat.mock.calls[1][0].think).toBeUndefined();
      // …the orchestrator's reasoning is surfaced…
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DELTA, {
        session_id: "s-sub-no-think",
        text_delta: "orchestrator reasoning",
      });
      // …but the sub-agent's reasoning is never emitted.
      expect(send).not.toHaveBeenCalledWith(
        CH.SESSION_THINKING_DELTA,
        expect.objectContaining({ text_delta: "sub-agent reasoning" }),
      );
    });

    it("ignores late thinking after the reasoning block was closed (no delta after done)", async () => {
      const send = vi.fn();
      ollamaMocks.show.mockResolvedValue({ capabilities: ["thinking"] });
      // Reasoning, then content (closes the block), then a stray late thinking chunk.
      ollamaMocks.chat.mockResolvedValue(
        streamChunks([
          { message: { thinking: "early reasoning" } },
          { message: { content: "Answer." } },
          { message: { thinking: "late reasoning" } },
        ]),
      );

      await runOllamaAgentTurn({
        db: makeDb([
          { id: "m-placeholder", role: "user", content: "placeholder" },
          { id: "m-user", role: "user", content: "hi" },
        ]) as never,
        sessionId: "s-late-think",
        messageId: "m-placeholder",
        projectConfig: { model: "qwen3:latest", approval_mode: "none", approval_rules: [] } as never,
        webContents: { send } as never,
      } as never);

      // The early reasoning and the done event are emitted in order…
      const thinkingDeltas = send.mock.calls.filter(([ch]) => ch === CH.SESSION_THINKING_DELTA);
      expect(thinkingDeltas).toEqual([
        [CH.SESSION_THINKING_DELTA, { session_id: "s-late-think", text_delta: "early reasoning" }],
      ]);
      // …and the late thinking chunk after thinkingDone is dropped entirely.
      expect(send).not.toHaveBeenCalledWith(
        CH.SESSION_THINKING_DELTA,
        expect.objectContaining({ text_delta: "late reasoning" }),
      );
      expect(send).toHaveBeenCalledWith(CH.SESSION_THINKING_DONE, { session_id: "s-late-think" });
    });
  });
});
