import { contextBridge, ipcRenderer } from "electron";
import * as CH from "./ipc-channels";
import type { ContractArgs, ContractResult, RequestChannel } from "./ipc-contract";
import { unwrap } from "./ipc/errors";

/**
 * ElectronAPI — typed surface exposed to the renderer via contextBridge.
 *
 * invoke()  → ipcMain.handle() (request/response)
 * on()      → webContents.send() push events (main → renderer)
 * off()     → removes a push-event listener
 *
 * Each request/response method's result type is derived from the shared
 * {@link IpcContract} via `Res<...>`, so the renderer surface can't promise a
 * shape the handler doesn't produce. Argument lists stay ergonomic (positional)
 * — the packing into the wire payload happens in the method body, which calls
 * the contract-typed `invoke()` and so is checked against the contract too.
 */
type Res<C extends RequestChannel> = ContractResult<C>;

export interface ElectronAPI {
  // ── Config ────────────────────────────────────────────────────────────────
  getApiKey: (provider: string) => Promise<Res<typeof CH.GET_API_KEY>>;
  getAnthropicConfig: () => Promise<Res<typeof CH.GET_ANTHROPIC_CONFIG>>;

  // ── Projects ──────────────────────────────────────────────────────────────
  addProject: (path: string) => Promise<Res<typeof CH.ADD_PROJECT>>;
  listProjects: () => Promise<Res<typeof CH.LIST_PROJECTS>>;
  removeProject: (id: string) => Promise<Res<typeof CH.REMOVE_PROJECT>>;
  getProjectConfig: (id: string) => Promise<Res<typeof CH.GET_PROJECT_CONFIG>>;
  saveProjectConfig: (
    id: string,
    config: import("../src/types").ProjectConfig
  ) => Promise<Res<typeof CH.SAVE_PROJECT_CONFIG>>;

  // ── Sessions ──────────────────────────────────────────────────────────────
  createSession: (
    projectId: string,
    providerOverride?: import("../src/types").Provider,
    issueNumber?: number
  ) => Promise<Res<typeof CH.CREATE_SESSION>>;
  listSessions: (projectId: string) => Promise<Res<typeof CH.LIST_SESSIONS>>;
  getSession: (sessionId: string) => Promise<Res<typeof CH.GET_SESSION>>;
  deleteSession: (sessionId: string, options?: { cleanupWorktree?: boolean }) => Promise<Res<typeof CH.DELETE_SESSION>>;
  saveMessage: (args: {
    sessionId: string;
    role: import("../src/types").Message["role"];
    content: string;
  }) => Promise<Res<typeof CH.SAVE_MESSAGE>>;
  updateSessionTitle: (sessionId: string, title: string) => Promise<Res<typeof CH.UPDATE_SESSION_TITLE>>;
  updateSessionModel: (
    sessionId: string,
    provider: import("../src/types").Provider,
    model: string
  ) => Promise<Res<typeof CH.UPDATE_SESSION_MODEL>>;
  updateSessionAgent: (sessionId: string, agent: string | null) => Promise<Res<typeof CH.UPDATE_SESSION_AGENT>>;
  updateSessionSkills: (sessionId: string, skills: string[]) => Promise<Res<typeof CH.UPDATE_SESSION_SKILLS>>;
  updateSessionDisabledMcp: (sessionId: string, names: string[]) => Promise<Res<typeof CH.UPDATE_SESSION_DISABLED_MCP>>;

  // ── File system ───────────────────────────────────────────────────────────
  listDirectory: (path: string) => Promise<Res<typeof CH.LIST_DIRECTORY>>;
  readFile: (path: string) => Promise<Res<typeof CH.READ_FILE>>;
  listMemory: (projectPath: string, provider?: import("../src/types").Provider) => Promise<Res<typeof CH.LIST_MEMORY>>;

  // ── Settings ──────────────────────────────────────────────────────────────
  settingsRead: () => Promise<Res<typeof CH.SETTINGS_READ>>;
  settingsWrite: (updates: Partial<import("./settings").SettingsMap>) => Promise<Res<typeof CH.SETTINGS_WRITE>>;

  // ── Dialog ────────────────────────────────────────────────────────────────
  openFolderDialog: () => Promise<Res<typeof CH.OPEN_FOLDER_DIALOG>>;
  openGitHubUrl: (url: string) => Promise<Res<typeof CH.OPEN_GITHUB_URL>>;

  // ── Agent ─────────────────────────────────────────────────────────────────
  agentSend: (args: {
    sessionId: string;
    prompt: string;
    agent?: string;
    oneshotSkills?: string[];
    skipPersistence?: boolean;
    messageId?: string;
  }) => Promise<Res<typeof CH.AGENT_SEND>>;
  agentQueueRecovery: (sessionId: string, action: "retry" | "skip" | "clear") => Promise<Res<typeof CH.AGENT_QUEUE_RECOVERY>>;
  approveToolCall: (
    sessionId: string,
    approvalId: string,
    approved: boolean,
    options?: { scope?: "once" | "session" | "project"; projectId?: string }
  ) => Promise<Res<typeof CH.APPROVE_TOOL_CALL>>;
  answerQuestion: (questionId: string, answer: string) => Promise<Res<typeof CH.ANSWER_QUESTION>>;
  getCopilotModels: () => Promise<Res<typeof CH.GET_COPILOT_MODELS>>;
  getOllamaModels: () => Promise<Res<typeof CH.GET_OLLAMA_MODELS>>;
  getOpenAiCompatModels: () => Promise<Res<typeof CH.GET_OPENAI_COMPAT_MODELS>>;
  getCodexModels: () => Promise<Res<typeof CH.GET_CODEX_MODELS>>;
  getClaudeAgents: (projectPath: string) => Promise<Res<typeof CH.GET_CLAUDE_AGENTS>>;
  getCopilotAgents: (projectPath: string) => Promise<Res<typeof CH.GET_COPILOT_AGENTS>>;
  githubCreatePr: (args: import("../src/types").GitHubCreatePrArgs) => Promise<Res<typeof CH.GITHUB_CREATE_PR>>;
  githubListPrs: (args: import("../src/types").GitHubListPrsArgs) => Promise<Res<typeof CH.GITHUB_LIST_PRS>>;
  githubListIssues: (args: import("../src/types").GitHubListIssuesArgs) => Promise<Res<typeof CH.GITHUB_LIST_ISSUES>>;
  githubGetIssue: (args: import("../src/types").GitHubGetIssueArgs) => Promise<Res<typeof CH.GITHUB_GET_ISSUE>>;
  githubGetCiStatus: (args: import("../src/types").GitHubGetCiStatusArgs) => Promise<Res<typeof CH.GITHUB_GET_CI_STATUS>>;
  githubGetPrContext: (args: import("../src/types").GitHubGetPrContextArgs) => Promise<Res<typeof CH.GITHUB_GET_PR_CONTEXT>>;
  listSkills: (projectPath: string, provider?: string) => Promise<Res<typeof CH.LIST_SKILLS>>;
  listMcpServers: () => Promise<Res<typeof CH.LIST_MCP_SERVERS>>;
  mcpProbeManaged: () => Promise<Res<typeof CH.MCP_PROBE_MANAGED>>;
  probeProviders: (args?: { projectId?: string; force?: boolean }) => Promise<Res<typeof CH.PROBE_PROVIDERS>>;
  readOpenAiEndpoints: () => Promise<Res<typeof CH.OPENAI_ENDPOINTS_READ>>;
  upsertOpenAiEndpoint: (
    name: string,
    entry: import("./openai-endpoints").OpenAiEndpointEntry
  ) => Promise<Res<typeof CH.OPENAI_ENDPOINT_UPSERT>>;
  deleteOpenAiEndpoint: (name: string) => Promise<Res<typeof CH.OPENAI_ENDPOINT_DELETE>>;
  mcpReadConfig: (args: {
    scope: import("./mcp").McpScope;
    projectPath?: string;
  }) => Promise<Res<typeof CH.MCP_READ_CONFIG>>;
  mcpWriteConfig: (args: {
    scope: import("./mcp").McpScope;
    servers: import("./mcp").McpServersMap;
    projectPath?: string;
  }) => Promise<Res<typeof CH.MCP_WRITE_CONFIG>>;
  mcpDeleteServer: (args: {
    scope: import("./mcp").McpScope;
    name: string;
    projectPath?: string;
  }) => Promise<Res<typeof CH.MCP_DELETE_SERVER>>;

  // ── Agent / Skill file management ─────────────────────────────────────────
  writeAgentFile: (args: { filePath: string; content: string }) => Promise<Res<typeof CH.WRITE_AGENT_FILE>>;
  deleteAgentFile: (filePath: string) => Promise<Res<typeof CH.DELETE_AGENT_FILE>>;
  createAgent: (args: {
    provider: string;
    name: string;
    projectPath: string;
    scope: "global" | "project";
    content: string;
  }) => Promise<Res<typeof CH.CREATE_AGENT>>;
  writeSkillFile: (args: { skillPath: string; content: string }) => Promise<Res<typeof CH.WRITE_SKILL_FILE>>;
  deleteSkillDir: (skillPath: string) => Promise<Res<typeof CH.DELETE_SKILL_DIR>>;
  createSkill: (args: {
    name: string;
    projectPath: string;
    scope: "global" | "project";
    content: string;
    provider?: string;
  }) => Promise<Res<typeof CH.CREATE_SKILL>>;

  // ── Workflows ─────────────────────────────────────────────────────────────
  workflowList: (args?: { projectId?: string }) => Promise<Res<typeof CH.WORKFLOW_LIST>>;
  workflowUpsert: (
    input: import("./ipc-contract").WorkflowUpsertInput
  ) => Promise<Res<typeof CH.WORKFLOW_UPSERT>>;
  workflowRunNow: (workflowId: string) => Promise<Res<typeof CH.WORKFLOW_RUN_NOW>>;
  workflowDelete: (workflowId: string) => Promise<Res<typeof CH.WORKFLOW_DELETE>>;
  workflowListRuns: (workflowId: string) => Promise<Res<typeof CH.WORKFLOW_LIST_RUNS>>;

  // ── Traces ────────────────────────────────────────────────────────────────
  getTraces: (sessionId?: string) => Promise<Res<typeof CH.GET_TRACES>>;
  bindTranscript: (sessionId: string) => Promise<Res<typeof CH.TRACE_BIND_TRANSCRIPT>>;
  unbindTranscript: (sessionId: string) => Promise<Res<typeof CH.TRACE_UNBIND_TRANSCRIPT>>;

  // ── Changes ───────────────────────────────────────────────────────────────
  getGitDiff: (projectPath: string) => Promise<Res<typeof CH.GET_GIT_DIFF>>;
  getGitBranch: (projectPath: string) => Promise<Res<typeof CH.GET_GIT_BRANCH>>;

  // ── Terminal ──────────────────────────────────────────────────────────────
  terminalCreate: (projectPath: string) => Promise<Res<typeof CH.TERMINAL_CREATE>>;
  terminalInput: (id: string, data: string) => Promise<Res<typeof CH.TERMINAL_INPUT>>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<Res<typeof CH.TERMINAL_RESIZE>>;
  terminalClose: (id: string) => Promise<Res<typeof CH.TERMINAL_CLOSE>>;

  // ── Push event bus ────────────────────────────────────────────────────────
  on: (channel: string, listener: (payload: unknown) => void) => void;
  off: (channel: string, listener: (payload: unknown) => void) => void;

  // ── Thinking / reasoning push subscriptions ───────────────────────────────
  onThinkingDelta: (cb: (payload: { session_id: string; text_delta: string }) => void) => () => void;
  onThinkingDone: (cb: (payload: { session_id: string }) => void) => () => void;
}

/**
 * The single contract-typed bridge to `ipcMain.handle`. It sends the wire args
 * for `channel`, then unwraps the {@link IpcEnvelope} the handler returns —
 * resolving with `data` or throwing an `IpcError` carrying the structured code.
 */
function invoke<C extends RequestChannel>(channel: C, ...args: ContractArgs<C>): Promise<ContractResult<C>> {
  return ipcRenderer.invoke(channel, ...args).then((env) => unwrap<ContractResult<C>>(env));
}

// Tracks the IpcRenderer-compatible wrapped function for each original listener
// so that off() can remove the exact same function that on() registered.
type IpcListener = Parameters<typeof ipcRenderer.on>[1];
const wrappedListeners = new Map<(payload: unknown) => void, IpcListener>();

const api: ElectronAPI = {
  getApiKey: (provider) => invoke(CH.GET_API_KEY, provider),
  getAnthropicConfig: () => invoke(CH.GET_ANTHROPIC_CONFIG),

  addProject: (path) => invoke(CH.ADD_PROJECT, path),
  listProjects: () => invoke(CH.LIST_PROJECTS),
  removeProject: (id) => invoke(CH.REMOVE_PROJECT, id),
  getProjectConfig: (id) => invoke(CH.GET_PROJECT_CONFIG, id),
  saveProjectConfig: (id, config) => invoke(CH.SAVE_PROJECT_CONFIG, id, config),

  createSession: (projectId, providerOverride, issueNumber) =>
    invoke(CH.CREATE_SESSION, { projectId, providerOverride, issueNumber }),
  listSessions: (projectId) => invoke(CH.LIST_SESSIONS, projectId),
  getSession: (sessionId) => invoke(CH.GET_SESSION, sessionId),
  deleteSession: (sessionId, options) => invoke(CH.DELETE_SESSION, sessionId, options),
  saveMessage: (args) => invoke(CH.SAVE_MESSAGE, args),
  updateSessionTitle: (sessionId, title) => invoke(CH.UPDATE_SESSION_TITLE, sessionId, title),
  updateSessionModel: (sessionId, provider, model) => invoke(CH.UPDATE_SESSION_MODEL, sessionId, provider, model),
  updateSessionAgent: (sessionId, agent) => invoke(CH.UPDATE_SESSION_AGENT, sessionId, agent),
  updateSessionSkills: (sessionId, skills) => invoke(CH.UPDATE_SESSION_SKILLS, sessionId, skills),
  updateSessionDisabledMcp: (sessionId, names) => invoke(CH.UPDATE_SESSION_DISABLED_MCP, sessionId, names),

  listDirectory: (path) => invoke(CH.LIST_DIRECTORY, path),
  readFile: (path) => invoke(CH.READ_FILE, path),
  listMemory: (projectPath, provider) => invoke(CH.LIST_MEMORY, { projectPath, provider }),

  settingsRead: () => invoke(CH.SETTINGS_READ),
  settingsWrite: (updates) => invoke(CH.SETTINGS_WRITE, updates),

  openFolderDialog: () => invoke(CH.OPEN_FOLDER_DIALOG),
  openGitHubUrl: (url) => invoke(CH.OPEN_GITHUB_URL, url),

  agentSend: (args) => invoke(CH.AGENT_SEND, args),
  agentQueueRecovery: (sessionId, action) => invoke(CH.AGENT_QUEUE_RECOVERY, { sessionId, action }),
  approveToolCall: (sessionId, approvalId, approved, options) =>
    invoke(CH.APPROVE_TOOL_CALL, { sessionId, approvalId, approved, ...options }),
  answerQuestion: (questionId, answer) => invoke(CH.ANSWER_QUESTION, { questionId, answer }),
  getCopilotModels: () => invoke(CH.GET_COPILOT_MODELS),
  getOllamaModels: () => invoke(CH.GET_OLLAMA_MODELS),
  getOpenAiCompatModels: () => invoke(CH.GET_OPENAI_COMPAT_MODELS),
  getCodexModels: () => invoke(CH.GET_CODEX_MODELS),
  getClaudeAgents: (projectPath) => invoke(CH.GET_CLAUDE_AGENTS, projectPath),
  getCopilotAgents: (projectPath) => invoke(CH.GET_COPILOT_AGENTS, projectPath),
  githubCreatePr: (args) => invoke(CH.GITHUB_CREATE_PR, args),
  githubListPrs: (args) => invoke(CH.GITHUB_LIST_PRS, args),
  githubListIssues: (args) => invoke(CH.GITHUB_LIST_ISSUES, args),
  githubGetIssue: (args) => invoke(CH.GITHUB_GET_ISSUE, args),
  githubGetCiStatus: (args) => invoke(CH.GITHUB_GET_CI_STATUS, args),
  githubGetPrContext: (args) => invoke(CH.GITHUB_GET_PR_CONTEXT, args),
  listSkills: (projectPath, provider) => invoke(CH.LIST_SKILLS, { projectPath, provider }),
  listMcpServers: () => invoke(CH.LIST_MCP_SERVERS),
  mcpProbeManaged: () => invoke(CH.MCP_PROBE_MANAGED),
  probeProviders: (args) => invoke(CH.PROBE_PROVIDERS, args),
  readOpenAiEndpoints: () => invoke(CH.OPENAI_ENDPOINTS_READ),
  upsertOpenAiEndpoint: (name, entry) => invoke(CH.OPENAI_ENDPOINT_UPSERT, name, entry),
  deleteOpenAiEndpoint: (name) => invoke(CH.OPENAI_ENDPOINT_DELETE, name),
  mcpReadConfig: (args) => invoke(CH.MCP_READ_CONFIG, args),
  mcpWriteConfig: (args) => invoke(CH.MCP_WRITE_CONFIG, args),
  mcpDeleteServer: (args) => invoke(CH.MCP_DELETE_SERVER, args),

  writeAgentFile: (args) => invoke(CH.WRITE_AGENT_FILE, args),
  deleteAgentFile: (filePath) => invoke(CH.DELETE_AGENT_FILE, filePath),
  createAgent: (args) => invoke(CH.CREATE_AGENT, args),
  writeSkillFile: (args) => invoke(CH.WRITE_SKILL_FILE, args),
  deleteSkillDir: (skillPath) => invoke(CH.DELETE_SKILL_DIR, skillPath),
  createSkill: (args) => invoke(CH.CREATE_SKILL, args),
  workflowList: (args) => invoke(CH.WORKFLOW_LIST, args ?? {}),
  workflowUpsert: (input) => invoke(CH.WORKFLOW_UPSERT, input),
  workflowRunNow: (workflowId) => invoke(CH.WORKFLOW_RUN_NOW, { workflowId }),
  workflowDelete: (workflowId) => invoke(CH.WORKFLOW_DELETE, { workflowId }),
  workflowListRuns: (workflowId) => invoke(CH.WORKFLOW_LIST_RUNS, { workflowId }),
  getTraces: (sessionId) => invoke(CH.GET_TRACES, sessionId),
  bindTranscript: (sessionId) => invoke(CH.TRACE_BIND_TRANSCRIPT, sessionId),
  unbindTranscript: (sessionId) => invoke(CH.TRACE_UNBIND_TRANSCRIPT, sessionId),
  getGitDiff: (projectPath) => invoke(CH.GET_GIT_DIFF, projectPath),
  getGitBranch: (projectPath) => invoke(CH.GET_GIT_BRANCH, projectPath),

  terminalCreate: (projectPath) => invoke(CH.TERMINAL_CREATE, projectPath),
  terminalInput: (id, data) => invoke(CH.TERMINAL_INPUT, id, data),
  terminalResize: (id, cols, rows) => invoke(CH.TERMINAL_RESIZE, id, cols, rows),
  terminalClose: (id) => invoke(CH.TERMINAL_CLOSE, id),

  on: (channel, listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => listener(payload);
    wrappedListeners.set(listener, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  off: (channel, listener) => {
    const wrapped = wrappedListeners.get(listener);
    if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
      wrappedListeners.delete(listener);
    }
  },

  onThinkingDelta: (cb) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown) =>
      cb(p as { session_id: string; text_delta: string });
    ipcRenderer.on(CH.SESSION_THINKING_DELTA, wrapped);
    return () => ipcRenderer.removeListener(CH.SESSION_THINKING_DELTA, wrapped);
  },
  onThinkingDone: (cb) => {
    const wrapped = (_e: Electron.IpcRendererEvent, p: unknown) =>
      cb(p as { session_id: string });
    ipcRenderer.on(CH.SESSION_THINKING_DONE, wrapped);
    return () => ipcRenderer.removeListener(CH.SESSION_THINKING_DONE, wrapped);
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
