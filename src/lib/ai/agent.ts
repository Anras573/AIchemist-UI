import { streamText, stepCountIs } from "ai";
import type { ToolSet, ModelMessage } from "ai";
import { buildModel } from "@/lib/ai/providers";
import type { Message, ProjectConfig } from "@/types";

export interface ToolCallEvent {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

export interface ApprovalRequestEvent {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /**
   * Call this to approve (true) or deny (false) the tool call.
   * The agent loop blocks until all `resolve` functions for a step are called.
   */
  resolve: (approved: boolean) => void;
}

export interface AgentTurnOptions {
  /** Full conversation history including the new user message just appended. */
  messages: Message[];
  projectConfig: ProjectConfig;
  tools?: ToolSet;
  /** Called with each text delta as it streams in. */
  onDelta: (delta: string) => void;
  /** Called when the LLM invokes a tool (before execution). */
  onToolCall?: (event: ToolCallEvent) => void;
  /** Called after a tool finishes executing. */
  onToolResult?: (event: ToolResultEvent) => void;
  /**
   * Called when a tool requires user approval before execution.
   * Caller MUST eventually call `event.resolve(true/false)` to unblock the loop.
   */
  onApprovalRequest?: (event: ApprovalRequestEvent) => void;
  /** Called once with the complete assistant response text when the turn finishes. */
  onComplete: (content: string) => Promise<void>;
}

/**
 * Convert our internal Message format to AI SDK ModelMessage format.
 */
function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content,
    }));
}

/**
 * Run one agent turn with support for mid-turn approval gates.
 *
 * Runs one LLM step at a time (`stopWhen: stepCountIs(1)`). After each step,
 * if there were tool-approval-request stream parts, fires `onApprovalRequest`
 * for each and waits for all decisions before the next step. Approved calls
 * are injected back into the message history via ToolApprovalResponse parts
 * that the SDK's `collectToolApprovals()` picks up at the start of each call.
 */
export async function runAgentTurn(options: AgentTurnOptions): Promise<void> {
  const MAX_STEPS = 20;
  const {
    messages,
    projectConfig,
    tools = {},
    onDelta,
    onToolCall,
    onToolResult,
    onApprovalRequest,
    onComplete,
  } = options;

  const model = await buildModel(projectConfig);

  // Mutable history extended with each step's response messages.
  let history: ModelMessage[] = toModelMessages(messages);
  let fullText = "";
  let stepCount = 0;

  while (stepCount < MAX_STEPS) {
    stepCount++;

    const result = streamText({
      model,
      messages: history,
      tools,
      stopWhen: stepCountIs(1),
      system:
        "You are a helpful AI assistant with access to the user's project files and tools. " +
        "Be concise and precise. When using tools, explain what you're doing before calling them.",
    });

    // Collect approval decisions from this step before the next.
    // Each entry is a Promise that resolves once the user decides.
    const approvalSettled: Array<Promise<{ approvalId: string; approved: boolean }>> = [];

    for await (const part of result.fullStream) {
      switch (part.type) {
        case "text-delta":
          fullText += part.text;
          onDelta(part.text);
          break;

        case "tool-call":
          onToolCall?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            args: part.input as Record<string, unknown>,
          });
          break;

        case "tool-result":
          onToolResult?.({
            toolCallId: part.toolCallId,
            toolName: part.toolName,
            result: part.output,
          });
          break;

        case "tool-approval-request": {
          const { approvalId, toolCallId, toolName } = part;
          let resolveDecision!: (approved: boolean) => void;
          const decision = new Promise<{ approvalId: string; approved: boolean }>((res) => {
            resolveDecision = (approved) => res({ approvalId, approved });
          });
          approvalSettled.push(decision);

          onApprovalRequest?.({
            approvalId,
            toolCallId,
            toolName,
            args: part.input as Record<string, unknown>,
            resolve: resolveDecision,
          });
          break;
        }

        case "error":
          throw part.error instanceof Error
            ? part.error
            : new Error(String(part.error));

        default:
          break;
      }
    }

    // If any approvals are pending, wait for all decisions then append them to history.
    if (approvalSettled.length > 0) {
      const decisions = await Promise.all(approvalSettled);
      history = [
        ...history,
        {
          role: "tool" as const,
          content: decisions.map(({ approvalId, approved }) => ({
            type: "tool-approval-response" as const,
            approvalId,
            approved,
          })),
        },
      ];
    }

    // Append the step's response messages to history for the next iteration.
    const stepResponse = await result.response;
    history = [...history, ...stepResponse.messages];

    // If the last message contained no tool calls, the model is done.
    const lastMsg = stepResponse.messages.at(-1);
    const hasToolCalls =
      lastMsg?.role === "assistant" &&
      Array.isArray(lastMsg.content) &&
      lastMsg.content.some((c) => (c as { type: string }).type === "tool-call");

    if (!hasToolCalls) break;
  }

  await onComplete(fullText);
}
