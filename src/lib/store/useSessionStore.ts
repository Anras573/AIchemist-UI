import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Session, SessionStatus, Message } from "@/types";

export interface LiveToolCall {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** undefined = still executing, value = completed */
  result?: unknown;
  error?: string;
}

export interface PendingApproval {
  approvalId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  /** Call with true to allow, false to deny. Resolves the Promise in the agent loop. */
  resolve: (approved: boolean) => void;
}

interface SessionStore {
  // All loaded sessions keyed by session id (can span multiple projects)
  sessions: Record<string, Session>;
  activeSessionId: string | null;
  // In-progress streaming text per session_id
  streamingText: Record<string, string>;
  // Ephemeral tool calls active during current agent turn, keyed by session id
  liveToolCalls: Record<string, LiveToolCall[]>;
  // Approval gates waiting for user decision, keyed by session id
  pendingApprovals: Record<string, PendingApproval[]>;

  mergeSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  appendMessage: (sessionId: string, message: Message) => void;
  appendStreamingDelta: (sessionId: string, delta: string) => void;
  clearStreamingText: (sessionId: string) => void;
  addLiveToolCall: (sessionId: string, call: LiveToolCall) => void;
  updateLiveToolResult: (sessionId: string, toolCallId: string, result: unknown) => void;
  updateLiveToolError: (sessionId: string, toolCallId: string, error: string) => void;
  clearLiveToolCalls: (sessionId: string) => void;
  // Approval gate actions
  addPendingApproval: (sessionId: string, approval: PendingApproval) => void;
  resolveApproval: (sessionId: string, approvalId: string, approved: boolean) => void;
  clearPendingApprovals: (sessionId: string) => void;
  // Terminal log — accumulates execute_bash output across a session's lifetime
  appendTerminalOutput: (sessionId: string, line: string) => void;
  clearTerminalOutput: (sessionId: string) => void;
  terminalOutput: Record<string, string>;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set) => ({
      sessions: {},
      activeSessionId: null,
      streamingText: {},
      liveToolCalls: {},
      pendingApprovals: {},
      terminalOutput: {},

      // Merge new sessions into the store without wiping sessions from other projects
      mergeSessions: (incoming) =>
        set((state) => ({
          sessions: {
            ...state.sessions,
            ...Object.fromEntries(incoming.map((s) => [s.id, s])),
          },
        })),

      setActiveSession: (id) => set({ activeSessionId: id }),

      addSession: (session) =>
        set((state) => ({
          sessions: { ...state.sessions, [session.id]: session },
        })),

      removeSession: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.sessions;
          return {
            sessions: rest,
            activeSessionId:
              state.activeSessionId === id ? null : state.activeSessionId,
          };
        }),

      updateSessionStatus: (sessionId, status) =>
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          return { sessions: { ...state.sessions, [sessionId]: { ...s, status } } };
        }),

      updateSessionTitle: (sessionId, title) =>
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          return { sessions: { ...state.sessions, [sessionId]: { ...s, title } } };
        }),

      appendMessage: (sessionId, message) =>
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...s, messages: [...s.messages, message] },
            },
          };
        }),

      appendStreamingDelta: (sessionId, delta) =>
        set((state) => ({
          streamingText: {
            ...state.streamingText,
            [sessionId]: (state.streamingText[sessionId] ?? "") + delta,
          },
        })),

      clearStreamingText: (sessionId) =>
        set((state) => {
          const { [sessionId]: _cleared, ...rest } = state.streamingText;
          return { streamingText: rest };
        }),

      addLiveToolCall: (sessionId, call) =>
        set((state) => ({
          liveToolCalls: {
            ...state.liveToolCalls,
            [sessionId]: [...(state.liveToolCalls[sessionId] ?? []), call],
          },
        })),

      updateLiveToolResult: (sessionId, toolCallId, result) =>
        set((state) => ({
          liveToolCalls: {
            ...state.liveToolCalls,
            [sessionId]: (state.liveToolCalls[sessionId] ?? []).map((c) =>
              c.toolCallId === toolCallId ? { ...c, result } : c
            ),
          },
        })),

      updateLiveToolError: (sessionId, toolCallId, error) =>
        set((state) => ({
          liveToolCalls: {
            ...state.liveToolCalls,
            [sessionId]: (state.liveToolCalls[sessionId] ?? []).map((c) =>
              c.toolCallId === toolCallId ? { ...c, error } : c
            ),
          },
        })),

      clearLiveToolCalls: (sessionId) =>
        set((state) => {
          const { [sessionId]: _cleared, ...rest } = state.liveToolCalls;
          return { liveToolCalls: rest };
        }),

      addPendingApproval: (sessionId, approval) =>
        set((state) => ({
          pendingApprovals: {
            ...state.pendingApprovals,
            [sessionId]: [...(state.pendingApprovals[sessionId] ?? []), approval],
          },
        })),

      resolveApproval: (sessionId, approvalId, approved) =>
        set((state) => {
          const approvals = state.pendingApprovals[sessionId] ?? [];
          const target = approvals.find((a) => a.approvalId === approvalId);
          if (target) target.resolve(approved);
          return {
            pendingApprovals: {
              ...state.pendingApprovals,
              [sessionId]: approvals.filter((a) => a.approvalId !== approvalId),
            },
          };
        }),

      clearPendingApprovals: (sessionId) =>
        set((state) => {
          // Deny all pending approvals before clearing to unblock any waiting agent
          (state.pendingApprovals[sessionId] ?? []).forEach((a) => a.resolve(false));
          const { [sessionId]: _cleared, ...rest } = state.pendingApprovals;
          return { pendingApprovals: rest };
        }),

      appendTerminalOutput: (sessionId, line) =>
        set((state) => ({
          terminalOutput: {
            ...state.terminalOutput,
            [sessionId]: (state.terminalOutput[sessionId] ?? "") + line,
          },
        })),

      clearTerminalOutput: (sessionId) =>
        set((state) => {
          const { [sessionId]: _cleared, ...rest } = state.terminalOutput;
          return { terminalOutput: rest };
        }),
    }),
    {
      name: "aichemist-session-store",
      // Only persist the active session selection; session data comes from SQLite
      partialize: (state) => ({ activeSessionId: state.activeSessionId }),
    }
  )
);
