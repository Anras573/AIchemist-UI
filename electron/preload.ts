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

  // ── File system ───────────────────────────────────────────────────────────
  listDirectory: (path: string) => Promise<{ entries: Array<{ name: string; path: string; is_dir: boolean; size_bytes: number }> }>;
  readFile: (path: string) => Promise<{ content: string } | { error: string }>;

  // ── Settings ──────────────────────────────────────────────────────────────
  settingsRead: () => Promise<import("./settings").SettingsMap>;
  settingsWrite: (updates: Partial<import("./settings").SettingsMap>) => Promise<void>;

  // ── Dialog ────────────────────────────────────────────────────────────────
  openFolderDialog: () => Promise<string | null>;

  // ── Agent ─────────────────────────────────────────────────────────────────
  agentSend: (args: { sessionId: string; prompt: string; agent?: string }) => Promise<void>;
  approveToolCall: (sessionId: string, approvalId: string, approved: boolean) => Promise<void>;
  getCopilotModels: () => Promise<Array<{ id: string; name: string }>>;
  getClaudeAgents: (projectPath: string) => Promise<Array<{ name: string; description: string; model?: string }>>;
  getCopilotAgents: (projectPath: string) => Promise<Array<{ name: string; description: string }>>;
  listSkills: (projectPath: string) => Promise<Array<{ name: string; description: string; path: string }>>;

  // ── Push event bus ────────────────────────────────────────────────────────
  on: (channel: string, listener: (payload: unknown) => void) => void;
  off: (channel: string, listener: (payload: unknown) => void) => void;
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

  listDirectory: (path) => ipcRenderer.invoke(CH.LIST_DIRECTORY, path),
  readFile: (path) => ipcRenderer.invoke(CH.READ_FILE, path),

  settingsRead: () => ipcRenderer.invoke(CH.SETTINGS_READ),
  settingsWrite: (updates) => ipcRenderer.invoke(CH.SETTINGS_WRITE, updates),

  openFolderDialog: () => ipcRenderer.invoke(CH.OPEN_FOLDER_DIALOG),

  agentSend: (args) => ipcRenderer.invoke(CH.AGENT_SEND, args),
  approveToolCall: (sessionId, approvalId, approved) =>
    ipcRenderer.invoke(CH.APPROVE_TOOL_CALL, { sessionId, approvalId, approved }),
  getCopilotModels: () => ipcRenderer.invoke(CH.GET_COPILOT_MODELS),
  getClaudeAgents: (projectPath) => ipcRenderer.invoke(CH.GET_CLAUDE_AGENTS, projectPath),
  getCopilotAgents: (projectPath) => ipcRenderer.invoke(CH.GET_COPILOT_AGENTS, projectPath),
  listSkills: (projectPath) => ipcRenderer.invoke(CH.LIST_SKILLS, projectPath),

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
};

contextBridge.exposeInMainWorld("electronAPI", api);
