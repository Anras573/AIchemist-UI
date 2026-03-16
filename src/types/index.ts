// AIchemist UI — shared types
// These mirror the Rust data model; field names use snake_case to match serde defaults.

// ─── Provider ────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "ollama" | "copilot" | string;

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

// ─── Project ─────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  provider: Provider;
  model: string;
  approval_mode: "all" | "none" | "custom";
  approval_rules: ApprovalRule[];
  custom_tools: ToolDefinition[];
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
}

export interface Session {
  id: string;
  project_id: string;
  title: string;
  status: SessionStatus;
  created_at: string;
  messages: Message[];
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
