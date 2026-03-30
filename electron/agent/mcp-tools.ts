import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectConfig } from "../../src/types/index";
import { z } from "zod";

import * as CH from "../ipc-channels";
import { requestApproval, needsApproval } from "./approval";
import {
  implWriteFileWithChange,
  implDeleteFileWithChange,
  implExecuteBash,
  implWebFetch,
} from "./tool-impls";

// ── Helper ────────────────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

// ── MCP server factory ────────────────────────────────────────────────────────

/**
 * Create an in-process MCP server whose tools are approval-gated.
 *
 * Uses dynamic `import()` so the ESM-only `@anthropic-ai/claude-agent-sdk` can
 * be loaded from a CommonJS main-process bundle.
 */
export async function createApprovalMcpServer(
  webContents: Electron.WebContents,
  sessionId: string,
  config: ProjectConfig,
  projectPath: string
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );

  // Shared helper: emit TOOL_CALL, check approval, run impl, emit TOOL_RESULT
  async function runTool(
    name: string,
    args: unknown,
    category: "filesystem" | "web",
    impl: () => Promise<string>
  ) {
    webContents.send(CH.SESSION_TOOL_CALL, {
      session_id: sessionId,
      tool_name: name,
      input: args,
    });

    if (needsApproval(config, category)) {
      const approved = await requestApproval(webContents, sessionId, name, args);
      if (!approved) {
        const result = textResult("Tool call denied by user.");
        webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: name, output: result });
        return result;
      }
    }

    const result = textResult(await impl());
    webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: name, output: result });
    return result;
  }

  // ── write_file ──────────────────────────────────────────────────────────────
  const writeFileTool = tool(
    "write_file",
    "Write content to a file, creating parent directories as needed.",
    { path: z.string().describe("Absolute or relative file path"), content: z.string().describe("Content to write") },
    (args) => runTool("write_file", args, "filesystem", async () => {
      const { result, change } = await implWriteFileWithChange(args, projectPath);
      if (change) webContents.send(CH.SESSION_FILE_CHANGE, { session_id: sessionId, file_change: change });
      return result;
    })
  );

  // ── delete_file ─────────────────────────────────────────────────────────────
  const deleteFileTool = tool(
    "delete_file",
    "Delete a file from the filesystem.",
    { path: z.string().describe("Absolute or relative path of the file to delete") },
    (args) => runTool("delete_file", args, "filesystem", async () => {
      const { result, change } = await implDeleteFileWithChange(args, projectPath);
      if (change) webContents.send(CH.SESSION_FILE_CHANGE, { session_id: sessionId, file_change: change });
      return result;
    })
  );

  // ── execute_bash ────────────────────────────────────────────────────────────
  // Shell is always approval-gated (enforced by needsApproval via "shell" category).
  const executeBashTool = tool(
    "execute_bash",
    "Execute a shell command and return its output. Always requires approval.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command"),
    },
    async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, { session_id: sessionId, tool_name: "execute_bash", input: args });

      const approved = await requestApproval(webContents, sessionId, "execute_bash", args);
      if (!approved) {
        const result = textResult("Tool call denied by user.");
        webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: "execute_bash", output: result });
        return result;
      }

      const result = textResult(await implExecuteBash(args));
      webContents.send(CH.SESSION_TOOL_RESULT, { session_id: sessionId, tool_name: "execute_bash", output: result });
      return result;
    }
  );

  // ── web_fetch ───────────────────────────────────────────────────────────────
  const webFetchTool = tool(
    "web_fetch",
    "Fetch a URL via HTTP GET and return its content.",
    { url: z.string().url().describe("URL to fetch") },
    (args) => runTool("web_fetch", args, "web", () => implWebFetch(args))
  );

  return createSdkMcpServer({
    name: "aichemist-tools",
    version: "1.0.0",
    tools: [writeFileTool, deleteFileTool, executeBashTool, webFetchTool],
  });
}
