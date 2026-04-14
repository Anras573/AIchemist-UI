// AIchemist UI — shared types
// These mirror the Rust data model; field names use snake_case to match serde defaults.

// ─── Provider ────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "copilot" | string;

// ─── Tool ────────────────────────────────────────────────────────────────────

export type ToolCategory = "filesystem" | "shell" | "web" | "custom";

export type ToolCallStatus =
  | "pending_approval"
  | "approved"
  | "rejected"
  | "complete"
  | "error";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown | null;
  status: ToolCallStatus;
  category: ToolCategory;
}

export interface ToolDefinition {
  name: string;
  description: string;
  // JSON Schema object for tool parameters (passed to AI SDK)
  parameters: Record<string, unknown>;
  category: ToolCategory | string;
  requires_approval: boolean | "inherit";
}

// ─── Approval ────────────────────────────────────────────────────────────────

export type ApprovalPolicy = "always" | "never" | "risky_only";

export interface ApprovalRule {
  tool_category: ToolCategory;
  policy: ApprovalPolicy;
}

/** A tool (or specific command) that is always allowed without prompting. */
export interface AllowedTool {
  tool_name: string;
  /**
   * For execute_bash: prefix-matched against the command string.
   * e.g. "mkdir" allows "mkdir -p foo/bar".
   * Omit to allow all invocations of tool_name.
   */
  command_pattern?: string;
}

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  provider: Provider;
  model: string;
  approval_mode: "all" | "none" | "custom";
  approval_rules: ApprovalRule[];
  custom_tools: ToolDefinition[];
  allowed_tools: AllowedTool[];
}

export interface Project {
  id: string;
  name: string;
  path: string;
  created_at: string;
  config: ProjectConfig;
}

// ─── Session ─────────────────────────────────────────────────────────────────

export type SessionStatus =
  | "idle"
  | "running"
  | "waiting_approval"
  | "error"
  | "complete";

export type MessageRole = "user" | "assistant" | "tool";

export interface Message {
  id: string;
  session_id: string;
  role: MessageRole;
  content: string;
  tool_calls: ToolCall[];
  created_at: string;
  agent?: string | null;
}

export interface Session {
  id: string;
  project_id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  messages: Message[];
  /** The AI provider used for this session (e.g. "anthropic", "copilot"). Null for legacy sessions. */
  provider: string | null;
  /** The model ID used for this session. Null for legacy sessions — runner falls back to project config. */
  model: string | null;
  /** The selected sub-agent name for this session. Null means the default agent. */
  agent: string | null;
  /** The active skills for this session (array of skill names). Null means no skills toggled. */
  skills: string[] | null;
}

// ─── IPC event payloads ──────────────────────────────────────────────────────

export interface SessionStatusEvent {
  session_id: string;
  status: SessionStatus;
}

export interface SessionDeltaEvent {
  session_id: string;
  text_delta: string;
}

export interface SessionMessageEvent {
  session_id: string;
  message: Message;
}

export interface SessionToolCallEvent {
  session_id: string;
  tool_call: ToolCall;
}

export interface SessionApprovalRequiredEvent {
  session_id: string;
  tool_call: ToolCall;
}

// ─── Agents & Skills ──────────────────────────────────────────────────────────

export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
  /** Absolute path to the agent's .md file. Undefined for SDK built-in agents. */
  path?: string;
  /** Whether the agent file can be edited or deleted. False for SDK built-ins. */
  editable?: boolean;
  /** Where this agent was discovered. */
  source?: "sdk" | "project" | "global" | "plugin";
  /** For plugin agents: the plugin identifier (e.g. "my-plugin@marketplace"). */
  plugin?: string;
}

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  /** Where this skill was discovered. Absent on very old entries — treat as editable. */
  source?: "project" | "global" | "plugin";
  /** For plugin skills: the plugin identifier (e.g. "my-org/my-plugin"). */
  plugin?: string;
}

export interface McpServerInfo {
  /** Display name of the MCP server. */
  name: string;
  /** The command or URL used to connect. */
  command: string;
  /** Transport type, if available (e.g. "HTTP", "stdio"). */
  transport?: string;
  /** Whether the server is currently connected. null = status unknown (Copilot config). */
  connected: boolean | null;
  /** Status message returned by `claude mcp list`. */
  status: string;
  /** Which provider(s) configured this server. */
  source: "claude" | "copilot" | "both";
}

// ─── File changes ─────────────────────────────────────────────────────────────

export interface FileChange {
  /** Absolute path to the file. */
  path: string;
  /** Path relative to the project root, for display. */
  relativePath: string;
  /** Pre-computed unified diff string (computed in main process). Empty when isBinary is true. */
  diff: string;
  operation: "write" | "delete";
  /** True when the file is binary — no diff is available. */
  isBinary?: boolean;
}

export interface SessionFileChangeEvent {
  session_id: string;
  file_change: FileChange;
}

export interface CompactionEvent {
  id: string;
  session_id: string;
  /** 'auto' = SDK triggered; 'manual' = user triggered */
  trigger: "auto" | "manual";
  /** Token count before compaction */
  pre_tokens: number;
  /** ISO timestamp when the compaction boundary was received */
  timestamp: string;
}

export interface SessionCompactionEvent {
  session_id: string;
  compaction: CompactionEvent;
}


export interface TraceSpan {
  id: string;
  /** Set for tool spans — points to the parent turn span id. */
  parentId?: string;
  sessionId: string;
  type: "turn" | "tool";
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: "running" | "success" | "error";
  meta?: Record<string, unknown>;
}
