import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { runAgentTurn } from "@/lib/ai/agent";
import { buildCoreTools } from "@/lib/ai/tools";
import type { Message } from "@/types";
import type { PendingApproval } from "@/lib/store/useSessionStore";

/**
 * Provides a stable `sendMessage` callback for the active session.
 * Orchestrates the full turn: persist user message → stream LLM response
 * → persist assistant message → update session status.
 */
export function useAgentTurn() {
  const {
    sessions,
    activeSessionId,
    updateSessionStatus,
    updateSessionTitle,
    appendMessage,
    appendStreamingDelta,
    clearStreamingText,
    addLiveToolCall,
    updateLiveToolResult,
    clearLiveToolCalls,
    appendTerminalOutput,
    addPendingApproval,
    clearPendingApprovals,
  } = useSessionStore();

  const { projects, activeProjectId } = useProjectStore();

  const sendMessage = useCallback(
    async (text: string) => {
      if (!activeSessionId) return;

      const session = sessions[activeSessionId];
      const project = projects.find((p) => p.id === activeProjectId);
      if (!session || !project) return;

      // 1. Persist the user message to SQLite and add it to the store
      let userMsg: Message;
      try {
        userMsg = await invoke<Message>("save_message", {
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
        invoke("update_session_title", { sessionId: activeSessionId, title })
          .then(() => updateSessionTitle(activeSessionId, title))
          .catch(console.error);
      }

      // 3. Run the agent turn
      updateSessionStatus(activeSessionId, "running");
      clearLiveToolCalls(activeSessionId);
      const sessionIdAtStart = activeSessionId; // capture for async closure

      try {
        await runAgentTurn({
          messages: [...session.messages, userMsg],
          projectConfig: project.config,
          tools: buildCoreTools(project.config),

          onDelta: (delta) => appendStreamingDelta(sessionIdAtStart, delta),

          onToolCall: ({ toolCallId, toolName, args }) =>
            addLiveToolCall(sessionIdAtStart, { toolCallId, toolName, args }),

          onApprovalRequest: ({ approvalId, toolCallId, toolName, args, resolve }) => {
            // Store the approval gate; the UI will call resolveApproval() which
            // invokes `resolve` and unblocks the agent loop's Promise.all.
            const approval: PendingApproval = { approvalId, toolCallId, toolName, args, resolve };
            addPendingApproval(sessionIdAtStart, approval);
            updateSessionStatus(sessionIdAtStart, "waiting_approval");
          },

          onToolResult: ({ toolCallId, toolName, result }) => {
            updateLiveToolResult(sessionIdAtStart, toolCallId, result);
            // Pipe bash output into the terminal log
            if (toolName === "execute_bash" && result && typeof result === "object") {
              const { stdout, stderr } = result as { stdout?: string; stderr?: string };
              if (stdout) appendTerminalOutput(sessionIdAtStart, stdout);
              if (stderr) appendTerminalOutput(sessionIdAtStart, `\x1b[31m${stderr}\x1b[0m`);
            }
          },

          onComplete: async (content) => {
            clearStreamingText(sessionIdAtStart);
            if (!content.trim()) return;
            try {
              const assistantMsg = await invoke<Message>("save_message", {
                sessionId: sessionIdAtStart,
                role: "assistant",
                content,
              });
              appendMessage(sessionIdAtStart, assistantMsg);
            } catch (err) {
              console.error("save_message (assistant) failed:", err);
            }
          },
        });

        clearLiveToolCalls(sessionIdAtStart);
        clearPendingApprovals(sessionIdAtStart);
        updateSessionStatus(sessionIdAtStart, "idle");
      } catch (err) {
        console.error("runAgentTurn failed:", err);
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
      updateSessionStatus,
      updateSessionTitle,
      appendMessage,
      appendStreamingDelta,
      clearStreamingText,
      addLiveToolCall,
      updateLiveToolResult,
      clearLiveToolCalls,
      appendTerminalOutput,
      addPendingApproval,
      clearPendingApprovals,
    ]
  );

  return { sendMessage };
}
