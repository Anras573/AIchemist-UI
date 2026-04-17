import React from "react";
import type { ProjectConfig } from "@/types";

// ── Typed wrapper over window.electronAPI ─────────────────────────────────────

export type { SettingsMap } from "../../electron/settings";

export const ipc = {
  // Config
  getApiKey: (provider: string) => window.electronAPI.getApiKey(provider),
  getAnthropicConfig: () => window.electronAPI.getAnthropicConfig(),

  // Projects
  addProject: (path: string) => window.electronAPI.addProject(path),
  listProjects: () => window.electronAPI.listProjects(),
  removeProject: (id: string) => window.electronAPI.removeProject(id),
  getProjectConfig: (id: string) => window.electronAPI.getProjectConfig(id),
  saveProjectConfig: (id: string, config: ProjectConfig) =>
    window.electronAPI.saveProjectConfig(id, config),

  // Sessions
  createSession: (projectId: string, providerOverride?: string) =>
    window.electronAPI.createSession(projectId, providerOverride),
  listSessions: (projectId: string) => window.electronAPI.listSessions(projectId),
  getSession: (sessionId: string) => window.electronAPI.getSession(sessionId),
  deleteSession: (sessionId: string) => window.electronAPI.deleteSession(sessionId),
  saveMessage: (args: { sessionId: string; role: string; content: string }) =>
    window.electronAPI.saveMessage(args),
  updateSessionTitle: (sessionId: string, title: string) =>
    window.electronAPI.updateSessionTitle(sessionId, title),
  updateSessionModel: (sessionId: string, provider: string, model: string) =>
    window.electronAPI.updateSessionModel(sessionId, provider, model),
  updateSessionAgent: (sessionId: string, agent: string | null) =>
    window.electronAPI.updateSessionAgent(sessionId, agent),
  updateSessionSkills: (sessionId: string, skills: string[]) =>
    window.electronAPI.updateSessionSkills(sessionId, skills),

  // File system
  listDirectory: (path: string) => window.electronAPI.listDirectory(path),
  readFile: (path: string) => window.electronAPI.readFile(path),

  // Dialog
  openFolderDialog: () => window.electronAPI.openFolderDialog(),

  // Settings
  settingsRead: () => window.electronAPI.settingsRead(),
  settingsWrite: (updates: Parameters<typeof window.electronAPI.settingsWrite>[0]) =>
    window.electronAPI.settingsWrite(updates),

  // Agent
  agentSend: (args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[] }) =>
    window.electronAPI.agentSend(args),
  approveToolCall: (sessionId: string, approvalId: string, approved: boolean, options?: { scope?: "once" | "session" | "project"; projectId?: string }) =>
    window.electronAPI.approveToolCall(sessionId, approvalId, approved, options),
  answerQuestion: (questionId: string, answer: string) =>
    window.electronAPI.answerQuestion(questionId, answer),
  getCopilotModels: () => window.electronAPI.getCopilotModels(),
  getClaudeAgents: (projectPath: string) => window.electronAPI.getClaudeAgents(projectPath),
  getCopilotAgents: (projectPath: string) => window.electronAPI.getCopilotAgents(projectPath),
  listSkills: (projectPath: string) => window.electronAPI.listSkills(projectPath),
  listMcpServers: () => window.electronAPI.listMcpServers(),
  mcpReadConfig: (args: Parameters<typeof window.electronAPI.mcpReadConfig>[0]) =>
    window.electronAPI.mcpReadConfig(args),
  mcpWriteConfig: (args: Parameters<typeof window.electronAPI.mcpWriteConfig>[0]) =>
    window.electronAPI.mcpWriteConfig(args),
  mcpDeleteServer: (args: Parameters<typeof window.electronAPI.mcpDeleteServer>[0]) =>
    window.electronAPI.mcpDeleteServer(args),

  // Agent / Skill file management
  writeAgentFile: (args: { filePath: string; content: string }) =>
    window.electronAPI.writeAgentFile(args),
  deleteAgentFile: (filePath: string) =>
    window.electronAPI.deleteAgentFile(filePath),
  createAgent: (args: { provider: string; name: string; projectPath: string; scope: "global" | "project"; content: string }) =>
    window.electronAPI.createAgent(args),
  writeSkillFile: (args: { skillPath: string; content: string }) =>
    window.electronAPI.writeSkillFile(args),
  deleteSkillDir: (skillPath: string) =>
    window.electronAPI.deleteSkillDir(skillPath),
  createSkill: (args: { name: string; projectPath: string; scope: "global" | "project"; content: string }) =>
    window.electronAPI.createSkill(args),

  // Traces
  getTraces: (sessionId?: string) => window.electronAPI.getTraces(sessionId),
  bindTranscript: (sessionId: string) => window.electronAPI.bindTranscript(sessionId),
  unbindTranscript: (sessionId: string) => window.electronAPI.unbindTranscript(sessionId),

  // Changes
  getGitDiff: (projectPath: string) => window.electronAPI.getGitDiff(projectPath),
  getGitBranch: (projectPath: string) => window.electronAPI.getGitBranch(projectPath),

  // Terminal
  terminalCreate: (projectPath: string) => window.electronAPI.terminalCreate(projectPath),
  terminalInput: (id: string, data: string) => window.electronAPI.terminalInput(id, data),
  terminalResize: (id: string, cols: number, rows: number) => window.electronAPI.terminalResize(id, cols, rows),
  terminalClose: (id: string) => window.electronAPI.terminalClose(id),
};

// ── Push-event subscription helper ────────────────────────────────────────────
// Returns an unsubscribe function — store it and call it on cleanup.

export function onSessionEvent<T>(
  channel: string,
  listener: (payload: T) => void
): () => void {
  const cb = (payload: unknown) => listener(payload as T);
  window.electronAPI.on(channel, cb);
  return () => window.electronAPI.off(channel, cb);
}

// ── Channel name constants ────────────────────────────────────────────────────
// String literals matching electron/ipc-channels.ts for use in onSessionEvent.

export const IPC_CHANNELS = {
  SESSION_STATUS: "session:status",
  SESSION_DELTA: "session:delta",
  SESSION_TOOL_CALL: "session:tool_call",
  SESSION_TOOL_RESULT: "session:tool_result",
  SESSION_APPROVAL_REQUIRED: "session:approval_required",
  SESSION_MESSAGE: "session:message",
  SESSION_TRACE: "session:trace",
  SESSION_FILE_CHANGE: "session:file_change",
  SESSION_COMPACTION: "session:compaction",
  TERMINAL_OUTPUT: "terminal:output",
  SESSION_THINKING_DELTA: "session:thinking-delta",
  SESSION_THINKING_DONE: "session:thinking-done",
  SESSION_QUESTION_REQUIRED: "session:question_required",
  CONFIG_WARNING: "config:warning",
} as const;

// ── Thinking / reasoning subscription helpers ─────────────────────────────────

export function onThinkingDelta(
  cb: (payload: { session_id: string; text_delta: string }) => void
): () => void {
  return window.electronAPI.onThinkingDelta(cb);
}

export function onThinkingDone(
  cb: (payload: { session_id: string }) => void
): () => void {
  return window.electronAPI.onThinkingDone(cb);
}

export type IpcClient = typeof ipc;
export const IpcContext = React.createContext<IpcClient>(ipc);
export function useIpc(): IpcClient {
  return React.useContext(IpcContext);
}
