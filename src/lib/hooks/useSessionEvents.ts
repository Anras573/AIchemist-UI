import { useEffect } from "react";
import { onSessionEvent, IPC_CHANNELS } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type {
  SessionStatusEvent,
  SessionDeltaEvent,
  SessionMessageEvent,
  SessionToolCallEvent,
  SessionApprovalRequiredEvent,
} from "@/types";

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

      // tool_call and approval_required events are handled in Phase 4+
      onSessionEvent<SessionToolCallEvent>(IPC_CHANNELS.SESSION_TOOL_CALL, () => {}),
      onSessionEvent<SessionApprovalRequiredEvent>(IPC_CHANNELS.SESSION_APPROVAL_REQUIRED, () => {}),
    ];

    return () => unsubs.forEach((fn) => fn());
  }, [updateSessionStatus, commitMessage, appendStreamingDelta, clearStreamingText]);
}
