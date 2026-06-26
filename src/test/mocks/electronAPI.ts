import { vi } from "vitest";

/**
 * Returns a fully-typed stub for window.electronAPI where every method is a
 * vi.fn() returning a resolved Promise. Individual tests can override specific
 * methods via vi.mocked(window.electronAPI.<method>).mockResolvedValue(...).
 */
export function createElectronAPIMock(): Window["electronAPI"] {
  const getApiKey = vi.fn().mockResolvedValue(null);
  const githubStubResponse = async () =>
    (await getApiKey("github"))
      ? { error: "not implemented" as const }
      : { error: "GITHUB_TOKEN not configured" as const };

  return {
    // Config
    getApiKey,
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
    updateSessionSkills: vi.fn().mockResolvedValue(undefined),

    // File system
    listDirectory: vi.fn().mockResolvedValue({ entries: [] }),
    readFile: vi.fn().mockResolvedValue({ content: "" }),
    listMemory: vi.fn().mockResolvedValue({ files: [] }),

    // Settings
    settingsRead: vi.fn().mockResolvedValue({}),
    settingsWrite: vi.fn().mockResolvedValue(undefined),

    // Dialog
    openFolderDialog: vi.fn().mockResolvedValue(null),
    openGitHubUrl: vi.fn().mockResolvedValue(undefined),

    // Agent
    agentSend: vi.fn().mockResolvedValue({ queued: false }),
    agentQueueRecovery: vi.fn().mockResolvedValue(undefined),
    approveToolCall: vi.fn().mockResolvedValue(undefined),
    answerQuestion: vi.fn().mockResolvedValue(undefined),
    getCopilotModels: vi.fn().mockResolvedValue([]),
    getOllamaModels: vi.fn().mockResolvedValue([]),
    getOpenAiCompatModels: vi.fn().mockResolvedValue([]),
    getCodexModels: vi.fn().mockResolvedValue([]),
    getClaudeAgents: vi.fn().mockResolvedValue([]),
    getCopilotAgents: vi.fn().mockResolvedValue([]),
    githubCreatePr: vi.fn().mockImplementation(githubStubResponse),
    githubListPrs: vi.fn().mockImplementation(githubStubResponse),
    githubListIssues: vi.fn().mockImplementation(githubStubResponse),
    githubGetIssue: vi.fn().mockImplementation(githubStubResponse),
    githubGetCiStatus: vi.fn().mockImplementation(githubStubResponse),
    githubGetPrContext: vi.fn().mockResolvedValue({ hasRemote: false, defaultBase: null }),
    listSkills: vi.fn().mockResolvedValue([]),
    listMcpServers: vi.fn().mockResolvedValue([]),
    mcpProbeManaged: vi.fn().mockResolvedValue([]),
    probeProviders: vi.fn().mockResolvedValue({
      anthropic: { ok: true },
      copilot: { ok: true },
      ollama: { ok: true },
      "openai-compatible": { ok: true },
      codex: { ok: false, reason: "Codex provider is not configured or implemented yet." },
    }),
    readOpenAiEndpoints: vi.fn().mockResolvedValue({}),
    upsertOpenAiEndpoint: vi.fn().mockResolvedValue({}),
    deleteOpenAiEndpoint: vi.fn().mockResolvedValue({}),
    updateSessionDisabledMcp: vi.fn().mockResolvedValue([]),
    mcpReadConfig: vi.fn().mockResolvedValue({}),
    mcpWriteConfig: vi.fn().mockResolvedValue(undefined),
    mcpDeleteServer: vi.fn().mockResolvedValue(undefined),

    // Agent / Skill file management
    writeAgentFile: vi.fn().mockResolvedValue(undefined),
    deleteAgentFile: vi.fn().mockResolvedValue(undefined),
    createAgent: vi.fn().mockResolvedValue({ filePath: "" }),
    writeSkillFile: vi.fn().mockResolvedValue(undefined),
    deleteSkillDir: vi.fn().mockResolvedValue(undefined),
    createSkill: vi.fn().mockResolvedValue({ skillPath: "" }),
    // Safe default shapes (stable ids + valid ISO timestamps) so tests that
    // don't override still get usable, invariant-respecting objects.
    workflowList: vi.fn().mockResolvedValue([]),
    workflowUpsert: vi.fn().mockResolvedValue({
      id: "mock-workflow-id",
      project_id: "mock-project-id",
      name: "Mock workflow",
      prompt: "mock prompt",
      provider: null,
      model: null,
      agent: null,
      skills: null,
      cron: null,
      watch_path: null,
      enabled: true,
      session_strategy: "fresh",
      reuse_session_id: null,
      autonomy: "interactive",
      created_at: "2026-01-01T00:00:00.000Z",
      last_run_at: null,
    }),
    workflowRunNow: vi.fn().mockResolvedValue({
      id: "mock-run-id",
      workflow_id: "mock-workflow-id",
      // A "success" run respects the persisted invariants: it has a session and
      // an ended_at, so UI logic doesn't treat it as still-running.
      session_id: "mock-session-id",
      status: "success",
      trigger: "manual",
      started_at: "2026-01-01T00:00:00.000Z",
      ended_at: "2026-01-01T00:00:01.000Z",
      error: null,
    }),
    workflowDelete: vi.fn().mockResolvedValue({ ok: true }),
    workflowListRuns: vi.fn().mockResolvedValue([]),
    getTraces: vi.fn().mockResolvedValue([]),
    bindTranscript: vi.fn().mockResolvedValue({ ok: true }),
    unbindTranscript: vi.fn().mockResolvedValue({ ok: true }),
    getGitDiff: vi.fn().mockResolvedValue(""),
    getGitBranch: vi.fn().mockResolvedValue(null),
    terminalCreate: vi.fn().mockResolvedValue("mock-terminal-id"),
    terminalInput: vi.fn().mockResolvedValue(undefined),
    terminalResize: vi.fn().mockResolvedValue(undefined),
    terminalClose: vi.fn().mockResolvedValue(undefined),

    // Push event bus
    on: vi.fn(),
    off: vi.fn(),

    // Thinking / reasoning
    onThinkingDelta: vi.fn().mockReturnValue(() => undefined),
    onThinkingDone: vi.fn().mockReturnValue(() => undefined),
  };
}
