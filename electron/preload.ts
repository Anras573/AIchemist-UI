import { contextBridge, ipcRenderer } from "electron";
import * as CH from "./ipc-channels";

/**
 * ElectronAPI — typed surface exposed to the renderer via contextBridge.
 *
 * invoke()  → ipcMain.handle() (request/response)
 * on()      → webContents.send() push events (main → renderer)
 * off()     → removes a push-event listener
 */
export interface ElectronAPI {
  // ── Config ────────────────────────────────────────────────────────────────
  getApiKey: (provider: string) => Promise<string | null>;
  getAnthropicConfig: () => Promise<{
    api_key: string | null;
    base_url: string | null;
    default_sonnet_model: string | null;
    default_haiku_model: string | null;
    default_opus_model: string | null;
  }>;

  // ── Projects ──────────────────────────────────────────────────────────────
  addProject: (path: string) => Promise<import("../src/types").Project>;
  listProjects: () => Promise<import("../src/types").Project[]>;
  removeProject: (id: string) => Promise<void>;
  getProjectConfig: (id: string) => Promise<import("../src/types").ProjectConfig>;
  saveProjectConfig: (id: string, config: import("../src/types").ProjectConfig) => Promise<void>;

  // ── Sessions ──────────────────────────────────────────────────────────────
  createSession: (projectId: string) => Promise<import("../src/types").Session>;
  listSessions: (projectId: string) => Promise<import("../src/types").Session[]>;
  getSession: (sessionId: string) => Promise<import("../src/types").Session>;
  deleteSession: (sessionId: string) => Promise<void>;
  saveMessage: (args: { sessionId: string; role: string; content: string }) => Promise<import("../src/types").Message>;
  updateSessionTitle: (sessionId: string, title: string) => Promise<void>;
  updateSessionModel: (sessionId: string, provider: string, model: string) => Promise<void>;
  updateSessionAgent: (sessionId: string, agent: string | null) => Promise<void>;
  updateSessionSkills: (sessionId: string, skills: string[]) => Promise<void>;

  // ── File system ───────────────────────────────────────────────────────────
  listDirectory: (path: string) => Promise<{ entries: Array<{ name: string; path: string; is_dir: boolean; size_bytes: number }> }>;
  readFile: (path: string) => Promise<{ content: string } | { error: string }>;

  // ── Settings ──────────────────────────────────────────────────────────────
  settingsRead: () => Promise<import("./settings").SettingsMap>;
  settingsWrite: (updates: Partial<import("./settings").SettingsMap>) => Promise<void>;

  // ── Dialog ────────────────────────────────────────────────────────────────
  openFolderDialog: () => Promise<string | null>;

  // ── Agent ─────────────────────────────────────────────────────────────────
  agentSend: (args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[] }) => Promise<void>;
  approveToolCall: (sessionId: string, approvalId: string, approved: boolean, options?: { scope?: "once" | "session" | "project"; projectId?: string }) => Promise<void>;
  answerQuestion: (questionId: string, answer: string) => Promise<void>;
  getCopilotModels: () => Promise<Array<{ id: string; name: string }>>;
  getClaudeAgents: (projectPath: string) => Promise<Array<{ name: string; description: string; model?: string }>>;
  getCopilotAgents: (projectPath: string) => Promise<Array<{ name: string; description: string }>>;
  listSkills: (projectPath: string) => Promise<Array<import("../src/types").SkillInfo>>;
  listMcpServers: () => Promise<Array<import("../src/types").McpServerInfo>>;

  // ── Agent / Skill file management ─────────────────────────────────────────
  writeAgentFile: (args: { filePath: string; content: string }) => Promise<void>;
  deleteAgentFile: (filePath: string) => Promise<void>;
  createAgent: (args: { provider: string; name: string; projectPath: string; scope: "global" | "project"; content: string }) => Promise<{ filePath: string }>;
  writeSkillFile: (args: { skillPath: string; content: string }) => Promise<void>;
  deleteSkillDir: (skillPath: string) => Promise<void>;
  createSkill: (args: { name: string; projectPath: string; scope: "global" | "project"; content: string }) => Promise<{ skillPath: string }>;

  // ── Traces ────────────────────────────────────────────────────────────────
  getTraces: (sessionId?: string) => Promise<import("../src/types").TraceSpan[]>;

  // ── Changes ───────────────────────────────────────────────────────────────
  getGitDiff: (projectPath: string) => Promise<string | { error: string }>;
  getGitBranch: (projectPath: string) => Promise<string | null>;

  // ── Terminal ──────────────────────────────────────────────────────────────
  terminalCreate: (projectPath: string) => Promise<string>;
  terminalInput: (id: string, data: string) => Promise<void>;
  terminalResize: (id: string, cols: number, rows: number) => Promise<void>;
  terminalClose: (id: string) => Promise<void>;

  // ── Push event bus ────────────────────────────────────────────────────────
  on: (channel: string, listener: (payload: unknown) => void) => void;
  off: (channel: string, listener: (payload: unknown) => void) => void;

  // ── Thinking / reasoning push subscriptions ───────────────────────────────
  onThinkingDelta: (cb: (payload: { session_id: string; text_delta: string }) => void) => () => void;
  onThinkingDone: (cb: (payload: { session_id: string }) => void) => () => void;
}

// Tracks the IpcRenderer-compatible wrapped function for each original listener
// so that off() can remove the exact same function that on() registered.
type IpcListener = Parameters<typeof ipcRenderer.on>[1];
const wrappedListeners = new Map<(payload: unknown) => void, IpcListener>();

const api: ElectronAPI = {
  getApiKey: (provider) => ipcRenderer.invoke(CH.GET_API_KEY, provider),
  getAnthropicConfig: () => ipcRenderer.invoke(CH.GET_ANTHROPIC_CONFIG),

  addProject: (path) => ipcRenderer.invoke(CH.ADD_PROJECT, path),
  listProjects: () => ipcRenderer.invoke(CH.LIST_PROJECTS),
  removeProject: (id) => ipcRenderer.invoke(CH.REMOVE_PROJECT, id),
  getProjectConfig: (id) => ipcRenderer.invoke(CH.GET_PROJECT_CONFIG, id),
  saveProjectConfig: (id, config) => ipcRenderer.invoke(CH.SAVE_PROJECT_CONFIG, id, config),

  createSession: (projectId) => ipcRenderer.invoke(CH.CREATE_SESSION, projectId),
  listSessions: (projectId) => ipcRenderer.invoke(CH.LIST_SESSIONS, projectId),
  getSession: (sessionId) => ipcRenderer.invoke(CH.GET_SESSION, sessionId),
  deleteSession: (sessionId) => ipcRenderer.invoke(CH.DELETE_SESSION, sessionId),
  saveMessage: (args) => ipcRenderer.invoke(CH.SAVE_MESSAGE, args),
  updateSessionTitle: (sessionId, title) => ipcRenderer.invoke(CH.UPDATE_SESSION_TITLE, sessionId, title),
  updateSessionModel: (sessionId, provider, model) => ipcRenderer.invoke(CH.UPDATE_SESSION_MODEL, sessionId, provider, model),
  updateSessionAgent: (sessionId, agent) => ipcRenderer.invoke(CH.UPDATE_SESSION_AGENT, sessionId, agent),
  updateSessionSkills: (sessionId, skills) => ipcRenderer.invoke(CH.UPDATE_SESSION_SKILLS, sessionId, skills),

  listDirectory: (path) => ipcRenderer.invoke(CH.LIST_DIRECTORY, path),
  readFile: (path) => ipcRenderer.invoke(CH.READ_FILE, path),

  settingsRead: () => ipcRenderer.invoke(CH.SETTINGS_READ),
  settingsWrite: (updates) => ipcRenderer.invoke(CH.SETTINGS_WRITE, updates),

  openFolderDialog: () => ipcRenderer.invoke(CH.OPEN_FOLDER_DIALOG),

  agentSend: (args) => ipcRenderer.invoke(CH.AGENT_SEND, args),
  approveToolCall: (sessionId, approvalId, approved, options) =>
    ipcRenderer.invoke(CH.APPROVE_TOOL_CALL, { sessionId, approvalId, approved, ...options }),
  answerQuestion: (questionId, answer) =>
    ipcRenderer.invoke(CH.ANSWER_QUESTION, { questionId, answer }),
  getCopilotModels: () => ipcRenderer.invoke(CH.GET_COPILOT_MODELS),
  getClaudeAgents: (projectPath) => ipcRenderer.invoke(CH.GET_CLAUDE_AGENTS, projectPath),
  getCopilotAgents: (projectPath) => ipcRenderer.invoke(CH.GET_COPILOT_AGENTS, projectPath),
  listSkills: (projectPath) => ipcRenderer.invoke(CH.LIST_SKILLS, projectPath),
  listMcpServers: () => ipcRenderer.invoke(CH.LIST_MCP_SERVERS),

  writeAgentFile: (args) => ipcRenderer.invoke(CH.WRITE_AGENT_FILE, args),
  deleteAgentFile: (filePath) => ipcRenderer.invoke(CH.DELETE_AGENT_FILE, filePath),
  createAgent: (args) => ipcRenderer.invoke(CH.CREATE_AGENT, args),
  writeSkillFile: (args) => ipcRenderer.invoke(CH.WRITE_SKILL_FILE, args),
  deleteSkillDir: (skillPath) => ipcRenderer.invoke(CH.DELETE_SKILL_DIR, skillPath),
  createSkill: (args) => ipcRenderer.invoke(CH.CREATE_SKILL, args),
  getTraces: (sessionId) => ipcRenderer.invoke(CH.GET_TRACES, sessionId),
  getGitDiff: (projectPath) => ipcRenderer.invoke(CH.GET_GIT_DIFF, projectPath),
  getGitBranch: (projectPath) => ipcRenderer.invoke(CH.GET_GIT_BRANCH, projectPath),

  terminalCreate: (projectPath) => ipcRenderer.invoke(CH.TERMINAL_CREATE, projectPath),
  terminalInput: (id, data) => ipcRenderer.invoke(CH.TERMINAL_INPUT, id, data),
  terminalResize: (id, cols, rows) => ipcRenderer.invoke(CH.TERMINAL_RESIZE, id, cols, rows),
  terminalClose: (id) => ipcRenderer.invoke(CH.TERMINAL_CLOSE, id),

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
