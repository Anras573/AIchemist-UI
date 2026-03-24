import { vi } from "vitest";

/**
 * Returns a fully-typed stub for window.electronAPI where every method is a
 * vi.fn() returning a resolved Promise. Individual tests can override specific
 * methods via vi.mocked(window.electronAPI.<method>).mockResolvedValue(...).
 */
export function createElectronAPIMock(): Window["electronAPI"] {
  return {
    // Config
    getApiKey: vi.fn().mockResolvedValue(null),
    getAnthropicConfig: vi.fn().mockResolvedValue({
      api_key: null,
      base_url: null,
      default_sonnet_model: null,
      default_haiku_model: null,
      default_opus_model: null,
    }),

    // Projects
    addProject: vi.fn().mockResolvedValue(undefined),
    listProjects: vi.fn().mockResolvedValue([]),
    removeProject: vi.fn().mockResolvedValue(undefined),
    getProjectConfig: vi.fn().mockResolvedValue(undefined),
    saveProjectConfig: vi.fn().mockResolvedValue(undefined),

    // Sessions
    createSession: vi.fn().mockResolvedValue(undefined),
    listSessions: vi.fn().mockResolvedValue([]),
    getSession: vi.fn().mockResolvedValue(undefined),
    deleteSession: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    updateSessionTitle: vi.fn().mockResolvedValue(undefined),
    updateSessionModel: vi.fn().mockResolvedValue(undefined),
    updateSessionAgent: vi.fn().mockResolvedValue(undefined),

    // File system
    listDirectory: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn().mockResolvedValue({ content: "" }),

    // Settings
    settingsRead: vi.fn().mockResolvedValue({}),
    settingsWrite: vi.fn().mockResolvedValue(undefined),

    // Dialog
    openFolderDialog: vi.fn().mockResolvedValue(null),

    // Agent
    agentSend: vi.fn().mockResolvedValue(undefined),
    approveToolCall: vi.fn().mockResolvedValue(undefined),
    getCopilotModels: vi.fn().mockResolvedValue([]),
    getClaudeAgents: vi.fn().mockResolvedValue([]),
    getCopilotAgents: vi.fn().mockResolvedValue([]),
    listSkills: vi.fn().mockResolvedValue([]),

    // Push event bus
    on: vi.fn(),
    off: vi.fn(),
  };
}
