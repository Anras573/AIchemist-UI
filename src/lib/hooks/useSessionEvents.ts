import { useEffect } from "react";
import { onSessionEvent, IPC_CHANNELS, ipc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type {
  SessionStatusEvent,
  SessionDeltaEvent,
  SessionMessageEvent,
} from "@/types";

// Actual payload shapes from the main process
interface ToolCallEvent {
  session_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

interface ToolResultEvent {
  session_id: string;
  tool_name: string;
  // mcp-tools sends { content: [{ type: "text", text: "..." }] }
  // copilot.ts sends a plain string
  output: string | { content: Array<{ type: string; text: string }> };
}

interface ApprovalRequiredEvent {
  session_id: string;
  approval_id: string;
  tool_name: string;
  input: Record<string, unknown>;
}

/** Extract a plain string from either mcp-tools or copilot output shapes. */
function extractOutput(
  output: ToolResultEvent["output"]
): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object" && "content" in output) {
    return output.content.map((c) => c.text ?? "").join("\n");
  }
  return String(output);
}

/** Parse execute_bash JSON output into human-readable terminal lines. */
function formatBashOutput(raw: string): string {
  try {
    const { stdout, stderr, exit_code } = JSON.parse(raw) as {
      stdout: string;
      stderr: string;
      exit_code: number;
    };
    const parts: string[] = [];
    if (stdout?.trim()) parts.push(stdout.trimEnd());
    if (stderr?.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
    if (exit_code !== 0) parts.push(`[exit code: ${exit_code}]`);
    return parts.join("\n") || "(no output)";
  } catch {
    return raw;
  }
}

/**
 * Mount once in AppShell. Subscribes to all session:* events emitted by the
 * Electron main process and updates the Zustand session store accordingly.
 */
export function useSessionEvents() {
  const {
    updateSessionStatus,
    commitMessage,
    appendStreamingDelta,
    clearStreamingText,
    addLiveToolCall,
    appendTerminalOutput,
    addPendingApproval,
  } = useSessionStore();

  useEffect(() => {
    const unsubs = [
      onSessionEvent<SessionStatusEvent>(IPC_CHANNELS.SESSION_STATUS, (payload) => {
        updateSessionStatus(payload.session_id, payload.status);
        if (payload.status === "idle" || payload.status === "error") {
          clearStreamingText(payload.session_id);
        }
      }),

      onSessionEvent<SessionDeltaEvent>(IPC_CHANNELS.SESSION_DELTA, (payload) => {
        appendStreamingDelta(payload.session_id, payload.text_delta);
      }),

      onSessionEvent<SessionMessageEvent>(IPC_CHANNELS.SESSION_MESSAGE, (payload) => {
        commitMessage(payload.session_id, payload.message);
      }),

      onSessionEvent<ToolCallEvent>(IPC_CHANNELS.SESSION_TOOL_CALL, (payload) => {
        addLiveToolCall(payload.session_id, {
          toolCallId: `${payload.tool_name}-${Date.now()}`,
          toolName: payload.tool_name,
          args: payload.input ?? {},
        });
      }),

      onSessionEvent<ToolResultEvent>(IPC_CHANNELS.SESSION_TOOL_RESULT, (payload) => {
        if (payload.tool_name === "execute_bash") {
          const raw = extractOutput(payload.output);
          const formatted = formatBashOutput(raw);
          appendTerminalOutput(payload.session_id, formatted + "\n\n");
        }
      }),

      onSessionEvent<ApprovalRequiredEvent>(
        IPC_CHANNELS.SESSION_APPROVAL_REQUIRED,
        (payload) => {
          addPendingApproval(payload.session_id, {
            approvalId: payload.approval_id,
            toolCallId: payload.approval_id,
            toolName: payload.tool_name,
            args: payload.input ?? {},
            // Calling resolve unblocks the agent in the main process
            resolve: (approved) =>
              ipc.approveToolCall(payload.session_id, payload.approval_id, approved),
          });
        }
      ),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, [
    updateSessionStatus,
    commitMessage,
    appendStreamingDelta,
    clearStreamingText,
    addLiveToolCall,
    appendTerminalOutput,
    addPendingApproval,
  ]);
}
