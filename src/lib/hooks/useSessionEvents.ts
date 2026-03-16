import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type {
  SessionStatusEvent,
  SessionDeltaEvent,
  SessionMessageEvent,
  SessionToolCallEvent,
  SessionApprovalRequiredEvent,
} from "@/types";

/**
 * Mount once in AppShell. Subscribes to all session:* events emitted by Rust
 * and updates the Zustand session store accordingly.
 */
export function useSessionEvents() {
  const {
    updateSessionStatus,
    appendMessage,
    appendStreamingDelta,
    clearStreamingText,
  } = useSessionStore();

  useEffect(() => {
    const unlisteners = Promise.all([
      listen<SessionStatusEvent>("session:status", ({ payload }) => {
        updateSessionStatus(payload.session_id, payload.status);
      }),

      listen<SessionDeltaEvent>("session:delta", ({ payload }) => {
        appendStreamingDelta(payload.session_id, payload.text_delta);
      }),

      listen<SessionMessageEvent>("session:message", ({ payload }) => {
        // A complete message arrived — commit it and clear the streaming buffer
        appendMessage(payload.session_id, payload.message);
        clearStreamingText(payload.session_id);
      }),

      // tool_call and approval_required events are handled in Phase 4+
      listen<SessionToolCallEvent>("session:tool_call", () => {}),
      listen<SessionApprovalRequiredEvent>("session:approval_required", () => {}),
    ]);

    return () => {
      unlisteners.then((fns) => fns.forEach((fn) => fn()));
    };
  }, [updateSessionStatus, appendMessage, appendStreamingDelta, clearStreamingText]);
}
