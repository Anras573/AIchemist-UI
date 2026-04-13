import { useCallback } from "react";
import { useIpc } from "@/lib/ipc";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Message } from "@/types";

/**
 * Provides a stable `sendMessage` callback for the active session.
 * Persists the user message, then dispatches to the Electron main process
 * via `ipc.agentSend`. LLM streaming events (deltas, tool calls, status)
 * arrive as push events handled by `useSessionEvents`.
 */
export function useAgentTurn() {
  const ipc = useIpc();
  const {
    sessions,
    activeSessionId,
    sessionAgents,
    updateSessionStatus,
    updateSessionTitle,
    appendMessage,
    clearStreamingText,
    clearLiveToolCalls,
    clearPendingApprovals,
  } = useSessionStore();

  const { projects, activeProjectId } = useProjectStore();

  const sendMessage = useCallback(
    async (text: string, oneshotSkills?: string[]) => {
      if (!activeSessionId) return;

      const session = sessions[activeSessionId];
      const project = projects.find((p) => p.id === activeProjectId);
      if (!session || !project) return;

      // 1. Persist the user message to SQLite and add it to the store
      let userMsg: Message;
      try {
        userMsg = await ipc.saveMessage({
          sessionId: activeSessionId,
          role: "user",
          content: text,
        });
      } catch (err) {
        console.error("save_message (user) failed:", err);
        return;
      }
      appendMessage(activeSessionId, userMsg);

      // 2. Auto-title the session from the first user message
      if (session.messages.length === 0) {
        const title = text.length > 60 ? text.slice(0, 57) + "…" : text;
        ipc.updateSessionTitle(activeSessionId, title)
          .then(() => updateSessionTitle(activeSessionId, title))
          .catch(console.error);
      }

      // 3. Run the agent turn via IPC — main process handles LLM dispatch
      updateSessionStatus(activeSessionId, "running");
      clearLiveToolCalls(activeSessionId);
      const sessionIdAtStart = activeSessionId;
      const activeAgent = sessionAgents[activeSessionId] ?? undefined;

      try {
        await ipc.agentSend({ sessionId: activeSessionId, prompt: text, agent: activeAgent, oneshotSkills });
        clearLiveToolCalls(sessionIdAtStart);
        clearPendingApprovals(sessionIdAtStart);
        // Status is updated via session:status push event from runner
      } catch (err) {
        console.error("agentSend failed:", err);
        clearStreamingText(sessionIdAtStart);
        clearLiveToolCalls(sessionIdAtStart);
        clearPendingApprovals(sessionIdAtStart);
        updateSessionStatus(sessionIdAtStart, "error");
      }
    },
    [
      activeSessionId,
      sessions,
      projects,
      activeProjectId,
      sessionAgents,
      updateSessionStatus,
      updateSessionTitle,
      appendMessage,
      clearStreamingText,
      clearLiveToolCalls,
      clearPendingApprovals,
    ]
  );

  return { sendMessage };
}

