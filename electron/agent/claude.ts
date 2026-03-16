import type { McpSdkServerConfigWithInstance, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "better-sqlite3";
import type { ProjectConfig } from "../../src/types/index";

import * as CH from "../ipc-channels";
import { createApprovalMcpServer } from "./mcp-tools";
import { getAnthropicConfig, resolveClaudePath } from "../config";

// ── Model resolution ───────────────────────────────────────────────────────────

function resolveModel(requestedModel: string): string {
  const {
    default_sonnet_model,
    default_haiku_model,
    default_opus_model,
  } = getAnthropicConfig();

  if (default_sonnet_model && requestedModel.includes("sonnet")) {
    return default_sonnet_model;
  }
  if (default_haiku_model && requestedModel.includes("haiku")) {
    return default_haiku_model;
  }
  if (default_opus_model && requestedModel.includes("opus")) {
    return default_opus_model;
  }
  return requestedModel;
}

// ── Main export ────────────────────────────────────────────────────────────────

export async function runClaudeAgentTurn(params: {
  db: Database;
  sessionId: string;
  sdkSessionId: string | null;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
}): Promise<string> {
  const { db, sessionId, sdkSessionId, prompt, projectPath, projectConfig, webContents } =
    params;

  // 1. Create the in-process MCP server (approval-gated custom tools)
  const mcpServer: McpSdkServerConfigWithInstance =
    await createApprovalMcpServer(webContents, sessionId, projectConfig);

  // 2. Resolve model ID with env-var overrides
  const model = resolveModel(projectConfig.model);

  // 3. Dynamic import — SDK is ESM-only, bundle is CJS
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // 4. Resolve claude CLI path (Electron doesn't inherit shell PATH on macOS)
  const claudePath = resolveClaudePath();

  // 5. Stream the query generator
  const queryStream: AsyncGenerator<SDKMessage, void> = query({
    prompt,
    options: {
      resume: sdkSessionId ?? undefined,
      model,
      cwd: projectPath,
      mcpServers: { "aichemist-tools": mcpServer },
      permissionMode: "acceptEdits",
      allowedTools: ["Read", "Glob", "LS"],
      includePartialMessages: true,
      ...(claudePath ? { pathToClaudeCodeExecutable: claudePath } : {}),
      systemPrompt:
        "You are a helpful AI assistant with access to the user's project files and tools. " +
        "Be concise and precise. When using tools, explain what you're doing before calling them.",
    },
  });

  let resultSessionId: string | null = null;
  let fullText = "";

  try {
    for await (const msg of queryStream) {
      if (msg.type === "stream_event") {
        // Extract streaming text deltas from the raw Anthropic stream event
        const event = msg.event as Record<string, unknown>;
        if (event["type"] === "content_block_delta") {
          const delta = event["delta"] as Record<string, unknown> | undefined;
          if (delta?.["type"] === "text_delta") {
            const text = delta["text"];
            if (typeof text === "string" && text.length > 0) {
              fullText += text;
              webContents.send(CH.SESSION_DELTA, {
                session_id: sessionId,
                text_delta: text,
              });
            }
          }
        }
      } else if (msg.type === "assistant") {
        // Completed assistant turn — emit tool_use blocks for native SDK tools
        // (custom MCP tools emit their own SESSION_TOOL_CALL in mcp-tools.ts)
        const content = (msg.message as { content: unknown[] }).content;
        for (const block of content) {
          const b = block as { type: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.name) {
            webContents.send(CH.SESSION_TOOL_CALL, {
              session_id: sessionId,
              tool_name: b.name,
              input: b.input ?? {},
            });
          }
        }
      } else if (msg.type === "result") {
        resultSessionId = msg.session_id;
      }
    }
  } catch (err) {
    throw err;
  }

  // 5. Persist sdk_session_id if it changed or was assigned for the first time
  if (resultSessionId && resultSessionId !== sdkSessionId) {
    db.prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?").run(
      resultSessionId,
      sessionId
    );
  }

  return fullText;
}
