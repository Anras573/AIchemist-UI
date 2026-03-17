import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";

import type {
  CopilotClient as CopilotClientType,
  PermissionRequest,
  PermissionRequestResult,
} from "@github/copilot-sdk";
import type { ProjectConfig } from "../../src/types/index";
import { getApiKey } from "../config";
import * as CH from "../ipc-channels";

// ── Singleton client ──────────────────────────────────────────────────────────

let clientInstance: CopilotClientType | null = null;

async function getClient(): Promise<CopilotClientType> {
  if (clientInstance) return clientInstance;
  const { CopilotClient } = await import("@github/copilot-sdk");
  const githubToken = getApiKey("github") ?? undefined;
  const client = new CopilotClient({ githubToken });
  await client.start();
  clientInstance = client;
  return client;
}

/** Gracefully stop the shared Copilot CLI client.
 * TODO: Call this in main.ts `app.on("before-quit")` to ensure clean shutdown
 *       of the spawned CLI process before the Electron app exits.
 */
export async function stopCopilotClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.stop();
    clientInstance = null;
  }
}

/** Return the list of models available for the authenticated Copilot user. */
export async function getCopilotModels(): Promise<Array<{ id: string; name: string }>> {
  const client = await getClient();
  const models = await client.listModels();
  return models.map((m) => ({ id: m.id, name: m.name }));
}

// ── Approval gate ─────────────────────────────────────────────────────────────
//
// This module maintains its own pendingApprovals map for tools defined here.
// TODO: The APPROVE_TOOL_CALL IPC handler in main.ts currently only calls
//       resolvePendingApproval from mcp-tools.ts. It should also call
//       resolveCopilotApproval (exported below) so that Copilot tool calls
//       are properly unblocked when the user approves/denies them.

const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; sessionId: string }
>();

/** Called by the IPC handler for `agent:approve-tool-call` to unblock a waiting Copilot tool. */
export function resolveCopilotApproval(
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

// ── Agent turn ────────────────────────────────────────────────────────────────

export async function runCopilotAgentTurn(params: {
  sessionId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
}): Promise<string> {
  const { sessionId, prompt, projectPath, projectConfig, webContents } = params;

  const { defineTool } = await import("@github/copilot-sdk");

  const client = await getClient();

  // ── Tool definitions ────────────────────────────────────────────────────────

  const writeFileTool = defineTool<{ path: string; content: string }>(
    "write_file",
    {
      description:
        "Write content to a file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
      handler: async (args) => {
        webContents.send(CH.SESSION_TOOL_CALL, {
          session_id: sessionId,
          tool_name: "write_file",
          input: args,
        });

        if (needsApproval(projectConfig, "filesystem")) {
          const approved = await requestApproval(
            webContents,
            sessionId,
            "write_file",
            args
          );
          if (!approved) {
            const msg = "Tool call denied by user.";
            webContents.send(CH.SESSION_TOOL_RESULT, {
              session_id: sessionId,
              tool_name: "write_file",
              output: msg,
            });
            return msg;
          }
        }

        try {
          fs.mkdirSync(path.dirname(args.path), { recursive: true });
          fs.writeFileSync(args.path, args.content, "utf8");
          const msg = `File written: ${args.path}`;
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "write_file",
            output: msg,
          });
          return msg;
        } catch (err) {
          const msg = `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "write_file",
            output: msg,
          });
          return msg;
        }
      },
    }
  );

  const deleteFileTool = defineTool<{ path: string }>("delete_file", {
    description: "Delete a file from the filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative path of the file to delete",
        },
      },
      required: ["path"],
    },
    handler: async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "delete_file",
        input: args,
      });

      if (needsApproval(projectConfig, "filesystem")) {
        const approved = await requestApproval(
          webContents,
          sessionId,
          "delete_file",
          args
        );
        if (!approved) {
          const msg = "Tool call denied by user.";
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "delete_file",
            output: msg,
          });
          return msg;
        }
      }

      try {
        fs.unlinkSync(args.path);
        const msg = `File deleted: ${args.path}`;
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "delete_file",
          output: msg,
        });
        return msg;
      } catch (err) {
        const msg = `Error deleting file: ${err instanceof Error ? err.message : String(err)}`;
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "delete_file",
          output: msg,
        });
        return msg;
      }
    },
  });

  const executeBashTool = defineTool<{ command: string; cwd?: string }>(
    "execute_bash",
    {
      description:
        "Execute a shell command and return its output. Always requires approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: {
            type: "string",
            description: "Working directory for the command",
          },
        },
        required: ["command"],
      },
      handler: async (args) => {
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
          const msg = "Tool call denied by user.";
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "execute_bash",
            output: msg,
          });
          return msg;
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

        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "execute_bash",
          output,
        });
        return output;
      },
    }
  );

  const webFetchTool = defineTool<{ url: string }>("web_fetch", {
    description: "Fetch a URL via HTTP GET and return its content.",
    // web_fetch is also a Copilot CLI built-in; override it so our version
    // handles the call (gives us IPC visibility + approval gating).
    overridesBuiltInTool: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
    handler: async (args) => {
      webContents.send(CH.SESSION_TOOL_CALL, {
        session_id: sessionId,
        tool_name: "web_fetch",
        input: args,
      });

      if (needsApproval(projectConfig, "web")) {
        const approved = await requestApproval(
          webContents,
          sessionId,
          "web_fetch",
          args
        );
        if (!approved) {
          const msg = "Tool call denied by user.";
          webContents.send(CH.SESSION_TOOL_RESULT, {
            session_id: sessionId,
            tool_name: "web_fetch",
            output: msg,
          });
          return msg;
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
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "web_fetch",
          output,
        });
        return output;
      } catch (err) {
        const msg = `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
        webContents.send(CH.SESSION_TOOL_RESULT, {
          session_id: sessionId,
          tool_name: "web_fetch",
          output: msg,
        });
        return msg;
      }
    },
  });

  // ── Permission handler for built-in CLI tools ───────────────────────────────
  // Our custom defineTool handlers gate approval themselves; this handles the
  // CLI's built-in tools (read_file, edit_file, run_shell, etc.).
  const onPermissionRequest = async (
    request: PermissionRequest
  ): Promise<PermissionRequestResult> => {
    let category: "filesystem" | "shell" | "web" | null = null;

    switch (request.kind) {
      case "shell":
        category = "shell";
        break;
      case "write":
      case "read":
      case "mcp":
        category = "filesystem";
        break;
      case "url":
        category = "web";
        break;
      case "custom-tool":
        // Custom defineTool handlers manage their own approval gate
        return { kind: "approved" };
    }

    if (category === null) return { kind: "approved" };

    // Shell operations are always approval-gated; others depend on project config
    const shouldGate =
      category === "shell" || needsApproval(projectConfig, category);

    if (!shouldGate) return { kind: "approved" };

    const approved = await requestApproval(
      webContents,
      sessionId,
      request.kind,
      request
    );

    return approved
      ? { kind: "approved" }
      : { kind: "denied-interactively-by-user" };
  };

  // ── Create session ──────────────────────────────────────────────────────────

  const session = await client.createSession({
    model: projectConfig.model,
    streaming: true,
    workingDirectory: projectPath,
    tools: [writeFileTool, deleteFileTool, executeBashTool, webFetchTool],
    onPermissionRequest,
  });

  // ── Event listeners — set up before sending ─────────────────────────────────

  let fullText = "";
  const done = new Promise<void>((resolve, reject) => {
    // The SDK emits "assistant.message" each time the accumulated text grows
    // (streaming). Track previous length to compute incremental deltas.
    session.on("assistant.message", (event) => {
      const newText: string = (event.data as { content: string }).content ?? "";
      const delta = newText.slice(fullText.length);
      fullText = newText;
      if (delta) {
        webContents.send(CH.SESSION_DELTA, {
          session_id: sessionId,
          text_delta: delta,
        });
      }
    });

    session.on("session.idle", () => resolve());
    session.on("session.error", (event) => {
      reject(new Error((event.data as { message: string }).message ?? "Copilot session error"));
    });
    session.on("session.abort", () => reject(new Error("Copilot session aborted")));
  });

  // ── Send & wait ─────────────────────────────────────────────────────────────

  try {
    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "running",
    });

    await session.send({ prompt });
    await done;

    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "complete",
    });
  } catch (err) {
    webContents.send(CH.SESSION_STATUS, {
      session_id: sessionId,
      status: "error",
    });
    throw err;
  } finally {
    await session.disconnect();
  }

  return fullText;
}
