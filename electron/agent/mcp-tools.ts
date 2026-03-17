import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { ProjectConfig } from "../../src/types/index";
import { z } from "zod";

import * as CH from "../ipc-channels";

// ── Approval gate ─────────────────────────────────────────────────────────────

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string }
>();

/** Called by the IPC handler for `agent:approve-tool-call` to unblock a waiting tool. */
export function resolvePendingApproval(
  approvalId: string,
  approved: boolean
): void {
  const pending = pendingApprovals.get(approvalId);
  if (pending) {
    pending.resolve(approved);
    pendingApprovals.delete(approvalId);
  }
}

async function requestApproval(
  webContents: Electron.WebContents,
  sessionId: string,
  toolName: string,
  input: unknown
): Promise<boolean> {
  const approvalId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingApprovals.set(approvalId, { resolve, sessionId });
    webContents.send(CH.SESSION_APPROVAL_REQUIRED, {
      session_id: sessionId,
      approval_id: approvalId,
      tool_name: toolName,
      input,
    });
  });
}

// ── Approval policy ───────────────────────────────────────────────────────────

function needsApproval(
  config: ProjectConfig,
  category: "filesystem" | "shell" | "web"
): boolean {
  if (config.approval_mode === "all") return true;
  if (config.approval_mode === "none") return false;
  const rule = config.approval_rules.find((r) => r.tool_category === category);
  return rule?.policy === "always";
}

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
  config: ProjectConfig
): Promise<McpSdkServerConfigWithInstance> {
  const { createSdkMcpServer, tool } = await import(
    "@anthropic-ai/claude-agent-sdk"
  );

  // ── write_file ──────────────────────────────────────────────────────────────
  const writeFileTool = tool(
    "write_file",
    "Write content to a file, creating parent directories as needed.",
    { path: z.string().describe("Absolute or relative file path"), content: z.string().describe("Content to write") },
    async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "write_file",
        input: args,
      });

      if (needsApproval(config, "filesystem")) {
        const approved = await requestApproval(
          webContents,
          sessionId,
          "write_file",
          args
        );
        if (!approved) {
          const result = textResult("Tool call denied by user.");
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "write_file",
            output: result,
          });
          return result;
        }
      }

      try {
        fs.mkdirSync(path.dirname(args.path), { recursive: true });
        fs.writeFileSync(args.path, args.content, "utf8");
        const result = textResult(`File written: ${args.path}`);
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "write_file",
          output: result,
        });
        return result;
      } catch (err) {
        const result = textResult(
          `Error writing file: ${err instanceof Error ? err.message : String(err)}`
        );
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "write_file",
          output: result,
        });
        return result;
      }
    }
  );

  // ── delete_file ─────────────────────────────────────────────────────────────
  const deleteFileTool = tool(
    "delete_file",
    "Delete a file from the filesystem.",
    { path: z.string().describe("Absolute or relative path of the file to delete") },
    async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "delete_file",
        input: args,
      });

      if (needsApproval(config, "filesystem")) {
        const approved = await requestApproval(
          webContents,
          sessionId,
          "delete_file",
          args
        );
        if (!approved) {
          const result = textResult("Tool call denied by user.");
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "delete_file",
            output: result,
          });
          return result;
        }
      }

      try {
        fs.unlinkSync(args.path);
        const result = textResult(`File deleted: ${args.path}`);
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "delete_file",
          output: result,
        });
        return result;
      } catch (err) {
        const result = textResult(
          `Error deleting file: ${err instanceof Error ? err.message : String(err)}`
        );
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "delete_file",
          output: result,
        });
        return result;
      }
    }
  );

  // ── execute_bash ────────────────────────────────────────────────────────────
  const executeBashTool = tool(
    "execute_bash",
    "Execute a shell command and return its output. Always requires approval.",
    {
      command: z.string().describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command"),
    },
    async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "execute_bash",
        input: args,
      });

      // Shell is always approval-gated regardless of policy
      const approved = await requestApproval(
        webContents,
        sessionId,
        "execute_bash",
        args
      );
      if (!approved) {
        const result = textResult("Tool call denied by user.");
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "execute_bash",
          output: result,
        });
        return result;
      }

      const proc = childProcess.spawnSync(args.command, {
        shell: true,
        cwd: args.cwd,
        encoding: "utf8",
      });

      const output = JSON.stringify({
        stdout: proc.stdout ?? "",
        stderr: proc.stderr ?? "",
        exit_code: proc.status ?? -1,
      });

      const result = textResult(output);
      webContents.send(CH.SESSION_TOOL_RESULT, {
        session_id: sessionId,
        tool_name: "execute_bash",
        output: result,
      });
      return result;
    }
  );

  // ── web_fetch ───────────────────────────────────────────────────────────────
  const webFetchTool = tool(
    "web_fetch",
    "Fetch a URL via HTTP GET and return its content.",
    { url: z.string().url().describe("URL to fetch") },
    async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "web_fetch",
        input: args,
      });

      if (needsApproval(config, "web")) {
        const approved = await requestApproval(
          webContents,
          sessionId,
          "web_fetch",
          args
        );
        if (!approved) {
          const result = textResult("Tool call denied by user.");
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "web_fetch",
            output: result,
          });
          return result;
        }
      }

      try {
        const response = await fetch(args.url);
        const body = await response.text();
        const output = JSON.stringify({
          url: args.url,
          status: response.status,
          content_type: response.headers.get("content-type") ?? "",
          body,
        });
        const result = textResult(output);
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "web_fetch",
          output: result,
        });
        return result;
      } catch (err) {
        const result = textResult(
          `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`
        );
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "web_fetch",
          output: result,
        });
        return result;
      }
    }
  );

  return createSdkMcpServer({
    name: "aichemist-tools",
    version: "1.0.0",
    tools: [writeFileTool, deleteFileTool, executeBashTool, webFetchTool],
  });
}
