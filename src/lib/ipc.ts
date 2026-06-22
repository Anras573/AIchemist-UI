import React from "react";
import type {
  GitHubCreatePrArgs,
  GitHubGetCiStatusArgs,
  GitHubGetIssueArgs,
  GitHubGetPrContextArgs,
  GitHubListIssuesArgs,
  GitHubListPrsArgs,
  MessageRole,
  ProjectConfig,
  Provider,
} from "@/types";
import type { IpcErrorCode } from "../../electron/ipc/errors";
import { isIpcErrorCode } from "../../electron/ipc/errors";

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
  createSession: (projectId: string, providerOverride?: Provider, issueNumber?: number) =>
    window.electronAPI.createSession(projectId, providerOverride, issueNumber),
  listSessions: (projectId: string) => window.electronAPI.listSessions(projectId),
  getSession: (sessionId: string) => window.electronAPI.getSession(sessionId),
  deleteSession: (sessionId: string, options?: { cleanupWorktree?: boolean }) =>
    window.electronAPI.deleteSession(sessionId, options),
  saveMessage: (args: { sessionId: string; role: MessageRole; content: string }) =>
    window.electronAPI.saveMessage(args),
  updateSessionTitle: (sessionId: string, title: string) =>
    window.electronAPI.updateSessionTitle(sessionId, title),
  updateSessionModel: (sessionId: string, provider: Provider, model: string) =>
    window.electronAPI.updateSessionModel(sessionId, provider, model),
  updateSessionAgent: (sessionId: string, agent: string | null) =>
    window.electronAPI.updateSessionAgent(sessionId, agent),
  updateSessionSkills: (sessionId: string, skills: string[]) =>
    window.electronAPI.updateSessionSkills(sessionId, skills),
  updateSessionDisabledMcp: (sessionId: string, names: string[]) =>
    window.electronAPI.updateSessionDisabledMcp(sessionId, names),

  // File system
  listDirectory: (path: string) => window.electronAPI.listDirectory(path),
  readFile: (path: string) => window.electronAPI.readFile(path),
  listMemory: (projectPath: string, provider?: Provider) =>
    window.electronAPI.listMemory(projectPath, provider),

  // Dialog
  openFolderDialog: () => window.electronAPI.openFolderDialog(),
  openGitHubUrl: (url: string) => window.electronAPI.openGitHubUrl(url),

  // Settings
  settingsRead: () => window.electronAPI.settingsRead(),
  settingsWrite: (updates: Parameters<typeof window.electronAPI.settingsWrite>[0]) =>
    window.electronAPI.settingsWrite(updates),

  // Agent
  agentSend: (args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[]; skipPersistence?: boolean; messageId?: string }) =>
    window.electronAPI.agentSend(args),
  agentQueueRecovery: (sessionId: string, action: "retry" | "skip" | "clear") =>
    window.electronAPI.agentQueueRecovery(sessionId, action),
  approveToolCall: (sessionId: string, approvalId: string, approved: boolean, options?: { scope?: "once" | "session" | "project"; projectId?: string }) =>
    window.electronAPI.approveToolCall(sessionId, approvalId, approved, options),
  answerQuestion: (questionId: string, answer: string) =>
    window.electronAPI.answerQuestion(questionId, answer),
  getCopilotModels: () => window.electronAPI.getCopilotModels(),
  getOllamaModels: () => window.electronAPI.getOllamaModels(),
  getOpenAiCompatModels: () => window.electronAPI.getOpenAiCompatModels(),
  getClaudeAgents: (projectPath: string) => window.electronAPI.getClaudeAgents(projectPath),
  getCopilotAgents: (projectPath: string) => window.electronAPI.getCopilotAgents(projectPath),
  githubCreatePr: (args: GitHubCreatePrArgs) => window.electronAPI.githubCreatePr(args),
  githubListPrs: (args: GitHubListPrsArgs) => window.electronAPI.githubListPrs(args),
  githubListIssues: (args: GitHubListIssuesArgs) => window.electronAPI.githubListIssues(args),
  githubGetIssue: (args: GitHubGetIssueArgs) => window.electronAPI.githubGetIssue(args),
  githubGetCiStatus: (args: GitHubGetCiStatusArgs) => window.electronAPI.githubGetCiStatus(args),
  githubGetPrContext: (args: GitHubGetPrContextArgs) => window.electronAPI.githubGetPrContext(args),
  listSkills: (projectPath: string, provider?: string) =>
    window.electronAPI.listSkills(projectPath, provider),
  listMcpServers: () => window.electronAPI.listMcpServers(),
  mcpProbeManaged: () => window.electronAPI.mcpProbeManaged(),
  probeProviders: (args?: { projectId?: string; force?: boolean }) =>
    window.electronAPI.probeProviders(args),
  readOpenAiEndpoints: () => window.electronAPI.readOpenAiEndpoints(),
  upsertOpenAiEndpoint: (name: string, entry: Parameters<typeof window.electronAPI.upsertOpenAiEndpoint>[1]) =>
    window.electronAPI.upsertOpenAiEndpoint(name, entry),
  deleteOpenAiEndpoint: (name: string) => window.electronAPI.deleteOpenAiEndpoint(name),
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
  createSkill: (args: { name: string; projectPath: string; scope: "global" | "project"; content: string; provider?: string }) =>
    window.electronAPI.createSkill(args),

  // Workflows
  workflowList: (args?: { projectId?: string }) => window.electronAPI.workflowList(args),
  workflowUpsert: (input: Parameters<typeof window.electronAPI.workflowUpsert>[0]) =>
    window.electronAPI.workflowUpsert(input),
  workflowRunNow: (workflowId: string) => window.electronAPI.workflowRunNow(workflowId),
  workflowDelete: (workflowId: string) => window.electronAPI.workflowDelete(workflowId),
  workflowListRuns: (workflowId: string) => window.electronAPI.workflowListRuns(workflowId),

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
  SESSION_USAGE: "session:usage",
  TERMINAL_OUTPUT: "terminal:output",
  SESSION_THINKING_DELTA: "session:thinking-delta",
  SESSION_THINKING_DONE: "session:thinking-done",
  SESSION_QUESTION_REQUIRED: "session:question_required",
  SESSION_QUEUE_TURN_START: "session:queue_turn_start",
  SESSION_QUEUE_RECOVERY_REQUIRED: "session:queue_recovery_required",
  CONFIG_WARNING: "config:warning",
  WORKTREE_WARNING: "worktree:warning",
  WORKFLOW_RUN_UPDATED: "workflow:run-updated",
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

// ── Structured errors ─────────────────────────────────────────────────────────
// A failed IPC call rejects with an error carrying a machine-readable `code`
// (e.g. "not_found", "conflict"). Note: errors crossing the contextBridge are
// not guaranteed to keep the `IpcError` prototype, so `instanceof IpcError` can
// fail in the renderer even when `code` is present. Branch on the code instead,
// via `ipcErrorCode()`:
//   catch (err) { if (ipcErrorCode(err) === "conflict") … }
export { IpcError } from "../../electron/ipc/errors";
export type { IpcErrorCode };

/**
 * Reads the structured error code off a rejected IPC call. Prefer this over
 * `instanceof IpcError` in renderer code — it works regardless of whether the
 * error kept its class prototype across the contextBridge. The code is
 * validated against the canonical set, so a non-IPC error that merely carries a
 * `code` string (e.g. a Node `"ENOENT"`) returns `undefined` rather than being
 * mis-typed as a valid IPC code (fall back to `err.message`).
 */
export function ipcErrorCode(err: unknown): IpcErrorCode | undefined {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return isIpcErrorCode(code) ? code : undefined;
  }
  return undefined;
}
