// AIchemist UI — shared types
// These mirror the Rust data model; field names use snake_case to match serde defaults.

export {
  ApprovalRuleSchema,
  AllowedToolSchema,
  ToolDefinitionSchema,
  ProjectConfigSchema,
} from "./schemas";

export type {
  ApprovalRule,
  AllowedTool,
  ToolDefinition,
  ProjectConfig,
} from "./schemas";

import type { ProjectConfig } from "./schemas";

// ─── Provider ────────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "copilot" | "ollama" | "openai-compatible" | "codex";

// ─── Provider availability ───────────────────────────────────────────────────

export interface ProviderProbeResult {
  ok: boolean;
  reason?: string;
  durationMs?: number;
}

export type ProviderProbes = Record<Provider, ProviderProbeResult>;

// ─── GitHub integration ────────────────────────────────────────────────────────

export interface GitHubPR {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  head_sha?: string;
  head_ref?: string;
  base_ref?: string;
  author?: string;
}

export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  state: string;
  html_url: string;
  created_at?: string;
  updated_at?: string;
  labels?: string[];
  body?: string;
}

export interface GitHubGetIssueArgs {
  projectPath: string;
  issueNumber: number;
}

export type GitHubGetIssueResult = { issue: GitHubIssue } | { error: string };

export interface CIStatus {
  state: string;
  sha?: string;
  target_url?: string;
  description?: string;
  context?: string;
}

export interface GitHubCreatePrArgs {
  projectPath: string;
  title: string;
  body?: string;
  base?: string;
  head?: string;
  draft?: boolean;
}

export interface GitHubListPrsArgs {
  projectPath: string;
  state?: "open" | "closed" | "all";
  base?: string;
  head?: string;
  limit?: number;
}

export interface GitHubListIssuesArgs {
  projectPath: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  limit?: number;
}

export interface GitHubGetCiStatusArgs {
  projectPath: string;
  ref?: string;
  prNumber?: number;
}

export interface GitHubGetPrContextArgs {
  projectPath: string;
}

export interface GitHubPrContext {
  hasRemote: boolean;
  defaultBase: string | null;
}

export type GitHubCreatePrResult = { pr: GitHubPR } | { error: string };
export type GitHubListPrsResult = { prs: GitHubPR[] } | { error: string };
export type GitHubListIssuesResult = { issues: GitHubIssue[] } | { error: string };
export type GitHubGetCiStatusResult = { status: CIStatus } | { error: string };
export type GitHubGetPrContextResult = GitHubPrContext;

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

// ─── Approval ────────────────────────────────────────────────────────────────

export type ApprovalPolicy = "always" | "never" | "risky_only";

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
  provider: Provider | null;
  /** The model ID used for this session. Null for legacy sessions — runner falls back to project config. */
  model: string | null;
  /** Branch created for the session when worktree-backed sessions are enabled. Null for fallback/main-checkout sessions. */
  branch: string | null;
  /** Working directory for the session runtime. Null for legacy sessions. */
  workspace_path: string | null;
  /** The selected sub-agent name for this session. Null means the default agent. */
  agent: string | null;
  /** The active skills for this session (array of skill names). Null means no skills toggled. */
  skills: string[] | null;
  /** Names of AIchemist-managed MCP servers disabled for this session. Null/empty/undefined means none disabled. */
  disabled_mcp_servers?: string[] | null;
  /** GitHub issue number linked at session creation time. Null when no issue is linked. */
  github_issue_number?: number | null;
}

// ─── Workflows ───────────────────────────────────────────────────────────────

/** How a workflow run picks its session. */
export type WorkflowSessionStrategy = "fresh" | "reuse";

/**
 * Unattended-execution policy for a workflow run.
 * - "interactive" — the run still pauses for approval / ask_user.
 * - "autonomous" — approvals resolve from the project/workflow allowlist without
 *   prompting; ask_user and un-allowlisted tools resolve immediately.
 */
export type WorkflowAutonomy = "interactive" | "autonomous";

/** A saved, repeatable agent task bound to a project. */
export interface Workflow {
  id: string;
  project_id: string;
  name: string;
  /** The task sent as the turn prompt. */
  prompt: string;
  /** Provider lock for runs. Null inherits the project default. */
  provider: Provider | null;
  /** Model override. Null inherits the project/provider default. */
  model: string | null;
  /** Selected agent name. Null means the default agent. */
  agent: string | null;
  /** Skills to activate for runs. Null means none. */
  skills: string[] | null;
  /** Cron expression. Null = manual-only workflow. */
  cron: string | null;
  /**
   * Filesystem path watched for changes. When set on an enabled workflow, the
   * scheduler arms a (debounced) file watcher that fires a run on any change
   * under the path. Null = no file trigger. Independent of `cron` — a workflow
   * may declare both, either, or neither (manual-only).
   */
  watch_path: string | null;
  /** The scheduler only arms enabled workflows. */
  enabled: boolean;
  session_strategy: WorkflowSessionStrategy;
  /** The session reused when session_strategy === "reuse". Null until created. */
  reuse_session_id: string | null;
  autonomy: WorkflowAutonomy;
  created_at: string;
  /** ISO timestamp of the most recent run, or null if never run. */
  last_run_at: string | null;
}

export type WorkflowRunStatus = "running" | "success" | "error" | "skipped";
export type WorkflowRunTrigger = "cron" | "manual" | "file";

/** One execution of a workflow. */
export interface WorkflowRun {
  id: string;
  workflow_id: string;
  /** The session the run executed in. Null if it never reached a session. */
  session_id: string | null;
  status: WorkflowRunStatus;
  trigger: WorkflowRunTrigger;
  started_at: string;
  ended_at: string | null;
  /** Error message when status === "error". */
  error: string | null;
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
  source: "claude" | "copilot" | "both" | "aichemist";
  /**
   * Tool names exposed by this server, populated when the server has been
   * actively probed (currently AIchemist-managed servers only).
   */
  tools?: string[];
  /**
   * Error message captured during the most recent probe. Set when
   * `connected === false` for an AIchemist-managed server.
   */
  error?: string;
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

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface SessionUsageEvent {
  session_id: string;
  usage: SessionUsage;
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

// ─── Budgets & spending ───────────────────────────────────────────────────────

export type BudgetPeriod = "daily" | "weekly" | "monthly";

/**
 * Persisted spending-budget configuration (`~/.aichemist/budget.json`). A `0`
 * or absent amount means "no budget set": for `globalAmountUSD` that
 * normalizes to `null`; for `providerAmountUSD`, a `0` override is dropped
 * from the map entirely (an absent key), never stored as `null`. Either way,
 * callers never special-case 0 separately from unset.
 */
export interface BudgetConfig {
  period: BudgetPeriod;
  /** USD. `null` = no global budget configured. */
  globalAmountUSD: number | null;
  /** Optional per-provider USD override; shares the global budget's reset period. A provider with no override is simply absent from this map. */
  providerAmountUSD: Partial<Record<Provider, number>>;
}

/** Computed spend/remaining/burn-rate for one budget line (global or a single provider) over the current period. */
export interface BudgetLineStatus {
  /** `null` = no budget configured for this line. */
  budgetUSD: number | null;
  spendUSD: number;
  /** `budgetUSD - spendUSD`. `null` when `budgetUSD` is null. */
  remainingUSD: number | null;
  /** Average USD/day spent so far in the current period. */
  burnRatePerDayUSD: number;
}

export interface ProviderBudgetStatus extends BudgetLineStatus {
  provider: Provider;
}

/** Result of BUDGET_GET_STATUS — the current period's spend against the configured budget(s). */
export interface BudgetStatus {
  period: BudgetPeriod;
  /** ISO timestamp, inclusive start of the current period. */
  periodStart: string;
  /** ISO timestamp, exclusive end of the current period. */
  periodEnd: string;
  global: BudgetLineStatus;
  /** One entry per provider with either a configured override or spend in the current period. */
  byProvider: ProviderBudgetStatus[];
}

// ─── Spending panel (issue #159) ────────────────────────────────────────────────

/**
 * Confidence in a computed cost figure (`electron/pricing.ts`):
 * `exact` — full token fidelity and a complete price for every field used.
 * `estimated` — a price resolved but may understate the true cost (partial
 *   provider fidelity, a pricing gap, or all-zero usage).
 * `unknown` — no pricing data for the provider/model; never "free".
 */
export type CostConfidence = "exact" | "estimated" | "unknown";

/** Time-range filter for SPENDING_GET_SUMMARY. A `null` bound is unbounded. */
export interface SpendingRangeFilter {
  since: string | null;
  until: string | null;
}

/** One provider's token usage + estimated cost for a time range — a row in the Spending panel's provider breakdown table. */
export interface SpendingProviderBreakdown {
  provider: Provider;
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  turn_count: number;
  costUSD: number;
  /** Worst-of the confidence across every provider/model group rolled into this row — never reports `exact` when any contributing group wasn't. */
  confidence: CostConfidence;
  /** 0-100, this row's share of `periodSpendUSD`. `0` when the period total is 0. */
  percentOfTotal: number;
}

/** Result of SPENDING_GET_SUMMARY — one project's spend for `range`, aggregated across every provider used in it, plus that project's all-time total. */
export interface SpendingSummary {
  projectId: string;
  range: SpendingRangeFilter;
  periodSpendUSD: number;
  lifetimeSpendUSD: number;
  /** Sorted by `costUSD` descending. */
  byProvider: SpendingProviderBreakdown[];
}
