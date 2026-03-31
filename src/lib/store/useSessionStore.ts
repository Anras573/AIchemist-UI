import { create } from "zustand";
import { persist } from "zustand/middleware";
import { Session, SessionStatus, Message, TraceSpan, FileChange, CompactionEvent } from "@/types";

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
  resolve: (approved: boolean, options?: { scope?: "once" | "session" | "project"; projectId?: string }) => void;
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
  // Active sub-agent per session (Claude only); null = default agent
  sessionAgents: Record<string, string | null>;
  // Active skills per session; empty array = no skills toggled
  sessionSkills: Record<string, string[]>;
  // Trace spans per session; accumulates live during a turn
  sessionTraces: Record<string, TraceSpan[]>;
  // File changes written during a session (from SESSION_FILE_CHANGE events)
  sessionFileChanges: Record<string, FileChange[]>;
  // Compaction events received during a session (from SESSION_COMPACTION events)
  sessionCompactions: Record<string, CompactionEvent[]>;
  addCompactionEvent: (sessionId: string, event: CompactionEvent) => void;

  mergeSessions: (sessions: Session[]) => void;
  setActiveSession: (id: string | null) => void;
  /** Replaces a session's messages with the full history loaded from the DB. */
  hydrateSession: (session: Session) => void;
  addSession: (session: Session) => void;
  removeSession: (id: string) => void;
  updateSessionStatus: (sessionId: string, status: SessionStatus) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionModel: (sessionId: string, provider: string, model: string) => void;
  appendMessage: (sessionId: string, message: Message) => void;
  /** Atomically appends a completed message and clears the streaming buffer. */
  commitMessage: (sessionId: string, message: Message) => void;
  appendStreamingDelta: (sessionId: string, delta: string) => void;
  clearStreamingText: (sessionId: string) => void;
  addLiveToolCall: (sessionId: string, call: LiveToolCall) => void;
  updateLiveToolResult: (sessionId: string, toolCallId: string, result: unknown) => void;
  updateLiveToolError: (sessionId: string, toolCallId: string, error: string) => void;
  clearLiveToolCalls: (sessionId: string) => void;
  // Approval gate actions
  addPendingApproval: (sessionId: string, approval: PendingApproval) => void;
  resolveApproval: (sessionId: string, approvalId: string, approved: boolean, options?: { scope?: "once" | "session" | "project"; projectId?: string }) => void;
  removeApproval: (sessionId: string, approvalId: string) => void;
  clearPendingApprovals: (sessionId: string) => void;
  // Terminal log — accumulates execute_bash output across a session's lifetime
  appendTerminalOutput: (sessionId: string, line: string) => void;
  clearTerminalOutput: (sessionId: string) => void;
  terminalOutput: Record<string, string>;
  setSessionAgent: (sessionId: string, agent: string | null) => void;
  setSessionSkills: (sessionId: string, skills: string[]) => void;
  addOrUpdateTraceSpan: (span: TraceSpan) => void;
  addFileChange: (sessionId: string, change: FileChange) => void;
  // Signals WorkspaceView to switch the context panel to a given tab
  tabSwitchRequest: string | null;
  requestTabSwitch: (tab: string) => void;
  clearTabSwitchRequest: () => void;
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
      sessionAgents: {},
      sessionSkills: {},
      sessionTraces: {},
      sessionFileChanges: {},
      sessionCompactions: {},
      tabSwitchRequest: null,

      // Merge new sessions into the store without wiping sessions from other projects.
      // Preserves messages already in the store — listSessions returns messages: [],
      // so we must not clobber messages loaded by hydrateSession or appendMessage.
      mergeSessions: (incoming) =>
        set((state) => ({
          sessions: {
            ...state.sessions,
            ...Object.fromEntries(
              incoming.map((s) => [
                s.id,
                {
                  ...s,
                  messages: state.sessions[s.id]?.messages ?? s.messages,
                },
              ])
            ),
          },
        })),

      setActiveSession: (id) => set({ activeSessionId: id }),

      hydrateSession: (session) =>
        set((state) => {
          const existing = state.sessions[session.id];
          const agentUpdate = session.agent != null
            ? { sessionAgents: { ...state.sessionAgents, [session.id]: session.agent } }
            : {};
          const skillsUpdate = session.skills != null && session.skills.length > 0
            ? { sessionSkills: { ...state.sessionSkills, [session.id]: session.skills } }
            : {};
          return {
            sessions: {
              ...state.sessions,
              [session.id]: {
                ...(existing ?? session),
                messages: session.messages,
                title: session.title,
              },
            },
            ...agentUpdate,
            ...skillsUpdate,
          };
        }),

      addSession: (session) =>
        set((state) => ({
          sessions: { ...state.sessions, [session.id]: session },
        })),

      removeSession: (id) =>
        set((state) => {
          const { [id]: _removed, ...rest } = state.sessions;
          const { [id]: _t, ...tracesRest } = state.sessionTraces;
          return {
            sessions: rest,
            sessionTraces: tracesRest,
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

      updateSessionModel: (sessionId, provider, model) =>
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          return { sessions: { ...state.sessions, [sessionId]: { ...s, provider, model } } };
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

      commitMessage: (sessionId, message) =>
        set((state) => {
          const s = state.sessions[sessionId];
          if (!s) return state;
          // Guard against duplicate delivery (e.g., double IPC dispatch)
          if (s.messages.some((m) => m.id === message.id)) return state;
          const { [sessionId]: _cleared, ...restStreaming } = state.streamingText;
          return {
            sessions: {
              ...state.sessions,
              [sessionId]: { ...s, messages: [...s.messages, message] },
            },
            streamingText: restStreaming,
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

      resolveApproval: (sessionId, approvalId, approved, options) =>
        set((state) => {
          const approvals = state.pendingApprovals[sessionId] ?? [];
          const target = approvals.find((a) => a.approvalId === approvalId);
          if (target) target.resolve(approved, options);
          return {
            pendingApprovals: {
              ...state.pendingApprovals,
              [sessionId]: approvals.filter((a) => a.approvalId !== approvalId),
            },
          };
        }),

      removeApproval: (sessionId, approvalId) =>
        set((state) => ({
          pendingApprovals: {
            ...state.pendingApprovals,
            [sessionId]: (state.pendingApprovals[sessionId] ?? []).filter(
              (a) => a.approvalId !== approvalId
            ),
          },
        })),

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

      setSessionAgent: (sessionId, agent) =>
        set((state) => ({
          sessionAgents: agent === null
            ? (() => { const { [sessionId]: _, ...rest } = state.sessionAgents; return rest; })()
            : { ...state.sessionAgents, [sessionId]: agent },
        })),

      setSessionSkills: (sessionId, skills) =>
        set((state) => ({
          sessionSkills: { ...state.sessionSkills, [sessionId]: skills },
        })),

      addOrUpdateTraceSpan: (span) =>
        set((state) => {
          const existing = state.sessionTraces[span.sessionId] ?? [];
          const idx = existing.findIndex((s) => s.id === span.id);
          const updated =
            idx >= 0
              ? [...existing.slice(0, idx), span, ...existing.slice(idx + 1)]
              : [...existing, span];
          return { sessionTraces: { ...state.sessionTraces, [span.sessionId]: updated } };
        }),

      addFileChange: (sessionId, change) =>
        set((state) => ({
          sessionFileChanges: {
            ...state.sessionFileChanges,
            [sessionId]: [...(state.sessionFileChanges[sessionId] ?? []), change],
          },
        })),

      addCompactionEvent: (sessionId, event) =>
        set((state) => ({
          sessionCompactions: {
            ...state.sessionCompactions,
            [sessionId]: [...(state.sessionCompactions[sessionId] ?? []), event],
          },
        })),

      requestTabSwitch: (tab) => set({ tabSwitchRequest: tab }),
      clearTabSwitchRequest: () => set({ tabSwitchRequest: null }),
    }),
    {
      name: "aichemist-session-store",
      // Only persist the active session selection; session data comes from SQLite
      partialize: (state) => ({ activeSessionId: state.activeSessionId }),
    }
  )
);
