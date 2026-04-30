#!/usr/bin/env bun
/**
 * Mock ACP agent — for end-to-end protocol smoke testing.
 *
 * Implements the Agent Client Protocol (ACP) over stdio with no LLM calls.
 * Lets you exercise AIchemist's ACP runner (electron/agent/acp.ts) without
 * needing API keys, network access, or a real model.
 *
 * Usage in AIchemist Project Settings → ACP Agent:
 *   Command: bun
 *   Args:    run <absolute path to this file>
 *
 * What each prompt does:
 *   - Echoes the user's message back as streaming agent_message_chunk events.
 *   - Emits a "Reading project files" tool_call (no permission required).
 *   - If the prompt contains "approve", "permission", or "write" — requests
 *     option-based permission via session/request_permission so you can test
 *     the approval card UI.
 *   - If the prompt contains "fail" — throws so you can test error surfacing.
 *   - If the prompt contains "long" — emits 5 chunks with delays to test
 *     streaming + the cancel button.
 *
 * Honors cancel — abortable via session/cancel.
 */

import * as acp from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import * as crypto from "node:crypto";

interface SessionState {
  pendingPrompt: AbortController | null;
}

class MockAgent {
  private readonly connection: acp.AgentSideConnection;
  private readonly sessions = new Map<string, SessionState>();

  constructor(connection: acp.AgentSideConnection) {
    this.connection = connection;
  }

  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
    };
  }

  async newSession() {
    const sessionId = crypto.randomBytes(8).toString("hex");
    this.sessions.set(sessionId, { pendingPrompt: null });
    return { sessionId };
  }

  async authenticate() {
    return {};
  }

  async setSessionMode() {
    return {};
  }

  async cancel(params: { sessionId: string }) {
    this.sessions.get(params.sessionId)?.pendingPrompt?.abort();
  }

  async prompt(params: {
    sessionId: string;
    prompt: Array<{ type: string; text?: string }>;
  }) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw new Error(`Session ${params.sessionId} not found`);

    session.pendingPrompt?.abort();
    session.pendingPrompt = new AbortController();
    const signal = session.pendingPrompt.signal;

    const userText = params.prompt
      .map((p) => (p.type === "text" ? p.text ?? "" : ""))
      .join("");
    const lower = userText.toLowerCase();

    try {
      if (lower.includes("fail")) {
        throw new Error("Mock agent: simulated failure");
      }

      await this.streamText(
        params.sessionId,
        `🤖 mock-acp-agent received: "${userText}"\n\n`,
        signal
      );

      await this.emitReadToolCall(params.sessionId, signal);

      if (lower.includes("long")) {
        for (let i = 1; i <= 5; i++) {
          if (signal.aborted) return { stopReason: "cancelled" as const };
          await this.streamText(
            params.sessionId,
            `Chunk ${i}/5 — pretend I'm thinking…\n`,
            signal
          );
          await sleep(600, signal);
        }
      }

      if (
        lower.includes("approve") ||
        lower.includes("permission") ||
        lower.includes("write")
      ) {
        const outcome = await this.requestWritePermission(params.sessionId, signal);
        await this.streamText(
          params.sessionId,
          outcome === "allow"
            ? "✅ Permission granted — pretending to write the file.\n"
            : "🛑 Permission denied — skipping the write.\n",
          signal
        );
      }

      await this.streamText(params.sessionId, "Done.\n", signal);
      return { stopReason: "end_turn" as const };
    } catch (err) {
      if (signal.aborted) return { stopReason: "cancelled" as const };
      throw err;
    } finally {
      session.pendingPrompt = null;
    }
  }

  private async streamText(sessionId: string, text: string, signal: AbortSignal) {
    if (signal.aborted) return;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    });
  }

  private async emitReadToolCall(sessionId: string, signal: AbortSignal) {
    if (signal.aborted) return;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "mock-read-1",
        title: "Reading project files",
        kind: "read",
        status: "pending",
      },
    });
    await sleep(300, signal);
    if (signal.aborted) return;
    await this.connection.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "mock-read-1",
        status: "completed",
        rawOutput: { files: ["package.json", "README.md"] },
      },
    });
  }

  private async requestWritePermission(
    sessionId: string,
    signal: AbortSignal
  ): Promise<"allow" | "deny"> {
    const response = await this.connection.requestPermission({
      sessionId,
      toolCall: {
        toolCallId: "mock-write-1",
        title: "Write to /tmp/mock-acp-test.txt",
        kind: "edit",
        status: "pending",
      },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    if (signal.aborted) return "deny";
    if (response.outcome.outcome === "selected") {
      return response.outcome.optionId === "allow" ? "allow" : "deny";
    }
    return "deny";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const timer = setTimeout(() => resolve(), ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true }
    );
  });
}

// stdin/stdout flipped vs typical: agent reads from stdin, writes to stdout.
const input = Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>;
const output = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(input, output);
new acp.AgentSideConnection((conn) => new MockAgent(conn), stream);
