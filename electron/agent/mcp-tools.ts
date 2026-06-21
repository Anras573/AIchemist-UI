import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

import { requestQuestion } from "./question";
import { runGatedTool } from "./tool-gate";
import type { GatedToolContext } from "./tool-gate";
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
 * Create an in-process MCP server whose tools are approval-gated via the
 * shared `runGatedTool()` pipeline.
 *
 * Uses dynamic `import()` so the ESM-only `@anthropic-ai/claude-agent-sdk` can
 * be loaded from a CommonJS main-process bundle.
 */
export async function createApprovalMcpServer(
  ctx: GatedToolContext & { projectPath: string }
): Promise<McpSdkServerConfigWithInstance> {
  const { sessionId, projectPath, emitter, nonInteractive } = ctx;
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );

  // ── write_file ──────────────────────────────────────────────────────────────
  const writeFileTool = tool(
    "write_file",
    "Write content to a file, creating parent directories as needed.",
    { path: z.string().describe("Absolute or relative file path"), content: z.string().describe("Content to write") },
    async (args) =>
      textResult(
        await runGatedTool(ctx, {
          name: "write_file",
          args,
          category: "filesystem",
          impl: async () => {
            const { result, change } = await implWriteFileWithChange(args, projectPath);
            if (change) emitter.fileChange(change);
            return result;
          },
        })
      )
  );

  // ── delete_file ─────────────────────────────────────────────────────────────
  const deleteFileTool = tool(
    "delete_file",
    "Delete a file from the filesystem.",
    { path: z.string().describe("Absolute or relative path of the file to delete") },
    async (args) =>
      textResult(
        await runGatedTool(ctx, {
          name: "delete_file",
          args,
          category: "filesystem",
          impl: async () => {
            const { result, change } = await implDeleteFileWithChange(args, projectPath);
            if (change) emitter.fileChange(change);
            return result;
          },
        })
      )
  );

  // ── execute_bash ────────────────────────────────────────────────────────────
  // Shell is always approval-gated (enforced by requiresApproval via "shell" category).
  const executeBashTool = tool(
    "execute_bash",
    "Execute a shell command and return its output. Always requires approval.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command"),
    },
    async (args) =>
      textResult(
        await runGatedTool(ctx, {
          name: "execute_bash",
          args,
          category: "shell",
          impl: () => implExecuteBash({ ...args, projectPath }),
        })
      )
  );

  // ── web_fetch ───────────────────────────────────────────────────────────────
  const webFetchTool = tool(
    "web_fetch",
    "Fetch a URL via HTTP GET and return its content.",
    { url: z.string().url().describe("URL to fetch") },
    async (args) =>
      textResult(
        await runGatedTool(ctx, {
          name: "web_fetch",
          args,
          category: "web",
          impl: () => implWebFetch(args),
        })
      )
  );

  // ── ask_user ────────────────────────────────────────────────────────────────
  const askUserTool = tool(
    "ask_user",
    "Ask the user a question and wait for their answer before proceeding. Use when you need clarification, missing information, or a decision from the user.",
    {
      question: z.string().describe("The question to ask the user"),
      options: z.array(z.string()).optional().describe("Optional list of pre-defined choices the user can click"),
      placeholder: z.string().optional().describe("Placeholder text for the free-form input field"),
    },
    async (args) => {
      const answer = await requestQuestion(
        emitter.webContents,
        sessionId,
        args.question,
        args.options,
        args.placeholder,
        { nonInteractive }
      );
      return textResult(answer || "(no answer provided)");
    }
  );

  return createSdkMcpServer({
    name: "aichemist-tools",
    version: "1.0.0",
    tools: [writeFileTool, deleteFileTool, executeBashTool, webFetchTool, askUserTool],
  });
}
