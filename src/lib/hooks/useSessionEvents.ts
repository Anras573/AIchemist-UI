import { useEffect } from "react";
import { onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type {
  SessionStatusEvent,
  SessionDeltaEvent,
  SessionMessageEvent,
  SessionApprovalRequiredEvent,
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
  output: string;
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
  } = useSessionStore();

  useEffect(() => {
    const unsubs = [
      onSessionEvent<SessionStatusEvent>(IPC_CHANNELS.SESSION_STATUS, (payload) => {
        updateSessionStatus(payload.session_id, payload.status);
        // Safety net: clear any leftover streaming text when the turn finishes
        if (payload.status === "idle" || payload.status === "error") {
          clearStreamingText(payload.session_id);
        }
      }),

      onSessionEvent<SessionDeltaEvent>(IPC_CHANNELS.SESSION_DELTA, (payload) => {
        appendStreamingDelta(payload.session_id, payload.text_delta);
      }),

      onSessionEvent<SessionMessageEvent>(IPC_CHANNELS.SESSION_MESSAGE, (payload) => {
        // Single atomic update: append message + clear streaming buffer
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
        // Append bash output to the terminal view
        if (payload.tool_name === "execute_bash") {
          appendTerminalOutput(payload.session_id, payload.output + "\n");
        }
      }),

      onSessionEvent<SessionApprovalRequiredEvent>(IPC_CHANNELS.SESSION_APPROVAL_REQUIRED, () => {}),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, [updateSessionStatus, commitMessage, appendStreamingDelta, clearStreamingText, addLiveToolCall, appendTerminalOutput]);
}
