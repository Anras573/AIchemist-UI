/**
 * IpcContract — the single typed source of truth for the request/response IPC
 * boundary. Each entry maps a channel constant (from `ipc-channels.ts`) to the
 * tuple of wire arguments `ipcRenderer.invoke` sends and the result the handler
 * resolves with (the success payload, before it is wrapped in an `IpcEnvelope`).
 *
 * Three surfaces are checked against this map so the wired pieces can't drift
 * out of sync:
 *   - `handle()` (electron/ipc/handle.ts) is generic over the contract, so a
 *     registered handler's args/result are checked against it.
 *   - the preload `invoke()` helper (electron/preload.ts) is generic over the
 *     contract, so every exposed method's wire call is checked against it.
 *   - `ElectronAPI` result types reference `ContractResult<...>`, so the renderer
 *     surface can't promise a shape the handler doesn't produce.
 *
 * Adding a channel still means wiring it in each place — a contract entry, a
 * handler, the preload method, and the renderer wrapper. The contract does NOT
 * force every channel to have a preload method (there's no exhaustiveness
 * check), but it does guarantee that whatever IS wired agrees: a handler or
 * `invoke(CH.X, …)` call whose args/result disagree with the channel's declared
 * shape is a compile error.
 */
import type * as CH from "./ipc-channels";
import type {
  Project,
  ProjectConfig,
  Session,
  Message,
  Provider,
  ProviderProbes,
  SkillInfo,
  McpServerInfo,
  TraceSpan,
  GitHubCreatePrArgs,
  GitHubCreatePrResult,
  GitHubListPrsArgs,
  GitHubListPrsResult,
  GitHubListIssuesArgs,
  GitHubListIssuesResult,
  GitHubGetIssueArgs,
  GitHubGetIssueResult,
  GitHubGetCiStatusArgs,
  GitHubGetCiStatusResult,
  GitHubGetPrContextArgs,
  GitHubGetPrContextResult,
  Workflow,
  WorkflowRun,
  WorkflowAutonomy,
  WorkflowSessionStrategy,
} from "../src/types";
import type { SettingsMap } from "./settings";
import type { OpenAiEndpointEntry, OpenAiEndpointsMap } from "./openai-endpoints";
import type { McpScope, McpServersMap } from "./mcp";

/** Result of the model-listing channels. */
type ModelList = Array<{ id: string; name: string }>;

/** A directory listing as returned by LIST_DIRECTORY. */
interface DirectoryListing {
  entries: Array<{ name: string; path: string; is_dir: boolean; size_bytes: number }>;
  truncated?: boolean;
}

/**
 * Wire payload for WORKFLOW_UPSERT. With an `id` referencing an existing
 * workflow it patches that row; otherwise it creates a new one (`projectId`,
 * `name`, and `prompt` are required for creation).
 */
export interface WorkflowUpsertInput {
  id?: string;
  projectId?: string;
  name?: string;
  prompt?: string;
  provider?: Provider | null;
  model?: string | null;
  agent?: string | null;
  skills?: string[] | null;
  cron?: string | null;
  enabled?: boolean;
  sessionStrategy?: WorkflowSessionStrategy;
  reuseSessionId?: string | null;
  autonomy?: WorkflowAutonomy;
}

/** Anthropic config snapshot from GET_ANTHROPIC_CONFIG. */
interface AnthropicConfig {
  api_key: string | null;
  base_url: string | null;
  default_sonnet_model: string | null;
  default_haiku_model: string | null;
  default_opus_model: string | null;
}

export type IpcContract = {
  // ── Config ──────────────────────────────────────────────────────────────
  [CH.GET_API_KEY]: { args: [provider: string]; result: string | null };
  [CH.GET_ANTHROPIC_CONFIG]: { args: []; result: AnthropicConfig };

  // ── Projects ────────────────────────────────────────────────────────────
  [CH.ADD_PROJECT]: { args: [path: string]; result: Project };
  [CH.LIST_PROJECTS]: { args: []; result: Project[] };
  [CH.REMOVE_PROJECT]: { args: [id: string]; result: void };
  [CH.GET_PROJECT_CONFIG]: { args: [id: string]; result: ProjectConfig };
  [CH.SAVE_PROJECT_CONFIG]: { args: [id: string, config: ProjectConfig]; result: void };

  // ── Sessions ────────────────────────────────────────────────────────────
  [CH.CREATE_SESSION]: {
    args: [payload: { projectId: string; providerOverride?: Provider; issueNumber?: number }];
    result: Session;
  };
  [CH.LIST_SESSIONS]: { args: [projectId: string]; result: Session[] };
  [CH.GET_SESSION]: { args: [sessionId: string]; result: Session };
  [CH.DELETE_SESSION]: { args: [sessionId: string, options?: { cleanupWorktree?: boolean }]; result: void };
  [CH.SAVE_MESSAGE]: {
    args: [args: { sessionId: string; role: Message["role"]; content: string }];
    result: Message;
  };
  [CH.UPDATE_SESSION_TITLE]: { args: [sessionId: string, title: string]; result: void };
  [CH.UPDATE_SESSION_MODEL]: { args: [sessionId: string, provider: Provider, model: string]; result: void };
  [CH.UPDATE_SESSION_AGENT]: { args: [sessionId: string, agent: string | null]; result: void };
  [CH.UPDATE_SESSION_SKILLS]: { args: [sessionId: string, skills: string[]]; result: void };
  [CH.UPDATE_SESSION_DISABLED_MCP]: { args: [sessionId: string, names: string[]]; result: string[] };

  // ── File system ───────────────────────────────────────────────────────────
  [CH.LIST_DIRECTORY]: { args: [path: string]; result: DirectoryListing };
  [CH.READ_FILE]: { args: [path: string]; result: { content: string } | { error: string } };
  [CH.LIST_MEMORY]: { args: [args: { projectPath: string; provider?: Provider }]; result: { files: Array<{ name: string; path: string }> } };

  // ── Settings ──────────────────────────────────────────────────────────────
  [CH.SETTINGS_READ]: { args: []; result: SettingsMap };
  [CH.SETTINGS_WRITE]: { args: [updates: Partial<SettingsMap>]; result: void };

  // ── Dialog / shell ──────────────────────────────────────────────────────────
  [CH.OPEN_FOLDER_DIALOG]: { args: []; result: string | null };
  [CH.OPEN_GITHUB_URL]: { args: [url: string]; result: void };

  // ── Agent ────────────────────────────────────────────────────────────────
  [CH.AGENT_SEND]: {
    args: [
      args: {
        sessionId: string;
        prompt: string;
        agent?: string;
        oneshotSkills?: string[];
        skipPersistence?: boolean;
        messageId?: string;
      },
    ];
    result: { queued: boolean };
  };
  [CH.AGENT_QUEUE_RECOVERY]: {
    args: [args: { sessionId: string; action: "retry" | "skip" | "clear" }];
    result: void;
  };
  [CH.APPROVE_TOOL_CALL]: {
    args: [
      args: {
        sessionId: string;
        approvalId: string;
        approved: boolean;
        scope?: "once" | "session" | "project";
        projectId?: string;
      },
    ];
    result: void;
  };
  [CH.ANSWER_QUESTION]: { args: [args: { questionId: string; answer: string }]; result: void };
  [CH.GET_COPILOT_MODELS]: { args: []; result: ModelList };
  [CH.GET_OLLAMA_MODELS]: { args: []; result: ModelList };
  [CH.GET_OPENAI_COMPAT_MODELS]: { args: []; result: ModelList };
  [CH.GET_CLAUDE_AGENTS]: {
    args: [projectPath: string];
    result: Array<{ name: string; description: string; model?: string }>;
  };
  [CH.GET_COPILOT_AGENTS]: { args: [projectPath: string]; result: Array<{ name: string; description: string }> };
  [CH.LIST_SKILLS]: { args: [args: { projectPath: string; provider?: string }]; result: SkillInfo[] };

  // ── GitHub ───────────────────────────────────────────────────────────────
  [CH.GITHUB_CREATE_PR]: { args: [args: GitHubCreatePrArgs]; result: GitHubCreatePrResult };
  [CH.GITHUB_LIST_PRS]: { args: [args: GitHubListPrsArgs]; result: GitHubListPrsResult };
  [CH.GITHUB_LIST_ISSUES]: { args: [args: GitHubListIssuesArgs]; result: GitHubListIssuesResult };
  [CH.GITHUB_GET_ISSUE]: { args: [args: GitHubGetIssueArgs]; result: GitHubGetIssueResult };
  [CH.GITHUB_GET_CI_STATUS]: { args: [args: GitHubGetCiStatusArgs]; result: GitHubGetCiStatusResult };
  [CH.GITHUB_GET_PR_CONTEXT]: { args: [args: GitHubGetPrContextArgs]; result: GitHubGetPrContextResult };

  // ── MCP servers ───────────────────────────────────────────────────────────
  [CH.LIST_MCP_SERVERS]: { args: []; result: McpServerInfo[] };
  [CH.MCP_PROBE_MANAGED]: { args: []; result: McpServerInfo[] };
  [CH.MCP_READ_CONFIG]: { args: [args: { scope: McpScope; projectPath?: string }]; result: McpServersMap };
  [CH.MCP_WRITE_CONFIG]: {
    args: [args: { scope: McpScope; servers: McpServersMap; projectPath?: string }];
    result: void;
  };
  [CH.MCP_DELETE_SERVER]: { args: [args: { scope: McpScope; name: string; projectPath?: string }]; result: void };

  // ── Provider probes ─────────────────────────────────────────────────────────
  [CH.PROBE_PROVIDERS]: { args: [args?: { projectId?: string; force?: boolean }]; result: ProviderProbes };

  // ── OpenAI-compatible endpoints ──────────────────────────────────────────────
  [CH.OPENAI_ENDPOINTS_READ]: { args: []; result: OpenAiEndpointsMap };
  [CH.OPENAI_ENDPOINT_UPSERT]: { args: [name: string, entry: OpenAiEndpointEntry]; result: OpenAiEndpointsMap };
  [CH.OPENAI_ENDPOINT_DELETE]: { args: [name: string]; result: OpenAiEndpointsMap };

  // ── Agent / Skill file management ────────────────────────────────────────────
  [CH.WRITE_AGENT_FILE]: { args: [args: { filePath: string; content: string }]; result: void };
  [CH.DELETE_AGENT_FILE]: { args: [filePath: string]; result: void };
  [CH.CREATE_AGENT]: {
    args: [
      args: { provider: string; name: string; projectPath: string; scope: "global" | "project"; content: string },
    ];
    result: { filePath: string };
  };
  [CH.WRITE_SKILL_FILE]: { args: [args: { skillPath: string; content: string }]; result: void };
  [CH.DELETE_SKILL_DIR]: { args: [skillPath: string]; result: void };
  [CH.CREATE_SKILL]: {
    args: [
      args: { name: string; projectPath: string; scope: "global" | "project"; content: string; provider?: string },
    ];
    result: { skillPath: string };
  };

  // ── Traces ──────────────────────────────────────────────────────────────────
  [CH.GET_TRACES]: { args: [sessionId?: string]; result: TraceSpan[] };
  [CH.TRACE_BIND_TRANSCRIPT]: { args: [sessionId: string]; result: { ok: boolean; reason?: string } };
  [CH.TRACE_UNBIND_TRANSCRIPT]: { args: [sessionId: string]; result: { ok: boolean } };

  // ── Changes (git) ─────────────────────────────────────────────────────────────
  [CH.GET_GIT_DIFF]: { args: [projectPath: string]; result: string | { error: string } };
  [CH.GET_GIT_BRANCH]: { args: [projectPath: string]; result: string | null };

  // ── Workflows ─────────────────────────────────────────────────────────────────
  [CH.WORKFLOW_UPSERT]: { args: [input: WorkflowUpsertInput]; result: Workflow };
  [CH.WORKFLOW_RUN_NOW]: { args: [args: { workflowId: string }]; result: WorkflowRun };
  [CH.WORKFLOW_DELETE]: { args: [args: { workflowId: string }]; result: { ok: boolean } };
  [CH.WORKFLOW_LIST_RUNS]: { args: [args: { workflowId: string }]; result: WorkflowRun[] };

  // ── Terminal ──────────────────────────────────────────────────────────────────
  [CH.TERMINAL_CREATE]: { args: [projectPath: string]; result: string };
  [CH.TERMINAL_INPUT]: { args: [id: string, data: string]; result: void };
  [CH.TERMINAL_RESIZE]: { args: [id: string, cols: number, rows: number]; result: void };
  [CH.TERMINAL_CLOSE]: { args: [id: string]; result: void };
};

/** Union of all request/response channel names covered by the contract. */
export type RequestChannel = keyof IpcContract;

/** Wire-argument tuple for a channel. */
export type ContractArgs<C extends RequestChannel> = IpcContract[C]["args"];

/** Success payload (pre-envelope) for a channel. */
export type ContractResult<C extends RequestChannel> = IpcContract[C]["result"];
