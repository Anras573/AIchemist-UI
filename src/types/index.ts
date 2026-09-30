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
  /** Origin tag for canvas-originated user messages (e.g. "canvas:kanban"). Null for ordinary messages. */
  source?: string | null;
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
  /**
   * Whether older messages exist beyond the `messages` page returned by this
   * call. Always `false` when `getSession()`/`GET_SESSION` was called without
   * pagination options (full history). Drives the "load older" affordance in
   * `TimelinePanel` (Virtuoso's `startReached`).
   */
  has_more_messages?: boolean;
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

// ─── Canvases ────────────────────────────────────────────────────────────────

/**
 * A canvas instance: a definition (a folder on disk, or a built-in) bound to a
 * project with its own persisted state. One definition can back many
 * instances — e.g. several kanban boards in the same project. Instances are
 * project-scoped (a board outlives a session); attachment to a session is
 * explicit, tracked separately (see `CanvasListItem.attached`).
 */
export interface Canvas {
  id: string;
  project_id: string;
  /** Definition name, resolved via discovery (project → global → built-in tiers). */
  definition: string;
  title: string;
  /** Persisted `ctx.state` JSON document (parsed, not the raw string). */
  state: unknown;
  /** Bumped on every state write. */
  revision: number;
  created_at: string;
  updated_at: string;
}

/** A canvas as listed for a specific session — adds whether it's attached to it. */
export interface CanvasListItem extends Canvas {
  attached: boolean;
}

/**
 * Shape of a canvas definition's manifest (`canvas.json`), validated by
 * `electron/canvas/manifest.ts`.
 */
export interface CanvasDefinition {
  name: string;
  description: string;
  version: number;
  /** Path to the server module, relative to the definition folder. */
  server: string;
  /** Path to the UI entry file, relative to the definition folder. */
  ui: string;
  /** Auto-attach to new sessions in the owning project. */
  attachByDefault?: boolean;
  /** Declared intent, shown in the trust prompt — unenforced in v1. */
  permissions?: {
    fs?: string[];
    network?: string[];
    exec?: string[];
  };
}

/**
 * Discovery tiers, in priority order (a higher tier suppresses a same-named
 * definition from a lower one) — same convention as `SkillInfo.source`.
 * `"project"` definitions are discovered but not yet runnable: they're
 * gated behind the trust model (a later issue), so `resolveCanvasServerPath`
 * deliberately never resolves them.
 */
export type CanvasDefinitionTier = "project" | "global" | "builtin";

/** A discovered, validated canvas definition. */
export interface CanvasDefinitionEntry {
  /** The definition's folder name — what `CANVAS_CREATE`'s `definition` field and `resolveCanvasServerPath` expect, not necessarily equal to `manifest.name`. */
  id: string;
  tier: CanvasDefinitionTier;
  manifest: CanvasDefinition;
  /** Absolute path to the definition's folder. */
  path: string;
}

/** A `canvas.json` that failed to read or validate — skipped, never breaks discovery. */
export interface CanvasManifestError {
  /** The folder name the manifest was found (or expected) in. */
  id: string;
  tier: CanvasDefinitionTier;
  path: string;
  reason: string;
}

/** `CANVAS_LIST_DEFINITIONS` result: valid definitions plus any manifest errors, surfaced in the Settings hub. */
export interface CanvasDiscoveryResult {
  definitions: CanvasDefinitionEntry[];
  errors: CanvasManifestError[];
}

/** Consent record for running a definition's server code within a project. */
export interface CanvasTrust {
  project_id: string;
  definition: string;
  /** Hash of the definition's server + manifest + package.json, to detect edits. */
  content_hash: string;
  /**
   * Hash of the definition's own `node_modules/` taken right after `bun
   * install` (#227 review round 3) — `content_hash` deliberately excludes
   * that folder (see `electron/canvas/trust.ts`), so this is what catches a
   * later write into it (e.g. a `git pull` adding files there). Null for a
   * definition with no dependencies to hash.
   */
  deps_hash: string | null;
  trusted_at: string;
}

/**
 * `package.json` dependency names declared by a project-tier definition, for
 * the trust prompt (#227) — `hasPackageJson` distinguishes "no dependencies
 * declared" (empty `names`, no install needed) from "no `package.json` at
 * all" (same `names: []`, but also nothing to run `bun install` against).
 */
export interface CanvasDependencyInfo {
  names: string[];
  hasPackageJson: boolean;
}

/**
 * `CANVAS_TRUST_STATUS` result for a project-tier definition: its manifest,
 * declared dependencies, current content hash, and whether a stored
 * `canvas_trust` record's hash still matches it. Null (at the call site) when
 * the folder isn't a valid project definition — missing, an unsafe name, or a
 * `canvas.json` that fails to read or validate.
 */
export interface CanvasTrustStatus {
  definition: string;
  /** Absolute path to the definition's folder, for display in the prompt. */
  path: string;
  manifest: CanvasDefinition;
  dependencies: CanvasDependencyInfo;
  contentHash: string;
  /** True iff a stored trust record's `content_hash` matches `contentHash`. Always false when `blockedReason` is set. */
  trusted: boolean;
  /** The stored record's `trusted_at`, only when `trusted` is true. */
  trustedAt: string | null;
  /**
   * Set when this definition structurally can't be trusted regardless of
   * content hash (currently: it contains a symlink, #227 review) — the
   * prompt shows this instead of offering "Trust and run", since a grant
   * would just be refused anyway.
   */
  blockedReason: string | null;
}

/** Result of running `bun install` in a just-trusted definition's folder — `{ ok: true, output: "" }` when it declares no `package.json` (most canvases). */
export interface CanvasInstallResult {
  ok: boolean;
  output: string;
}

/** `CANVAS_TRUST_GRANT` result. */
export interface CanvasTrustGrantResult {
  trust: CanvasTrust;
  install: CanvasInstallResult;
}

/**
 * A canvas host process's lifecycle state, mirroring
 * `electron/canvas/host-manager.ts`'s `CanvasHostStatus`. Duplicated here
 * (rather than imported) because the renderer can only type-import from
 * `electron/` for Node-only modules — same rule as the tool-round-cap bounds
 * in `SettingsView.tsx`.
 */
export type CanvasHostStatus = "starting" | "running" | "stopped" | "crashed" | "errored" | "untrusted";

/**
 * Push payload for `CANVAS_EVENT` (main → renderer): a host status change, a
 * persisted state write, a UI message relayed from the host, a debug log
 * line, or a dev-reload notice (#226 — a running host's definition folder
 * changed and was restarted; the UI should re-navigate its iframe). Exactly
 * one of `state`/`revision`, `message`, `status`, or `level`/`args` is
 * populated, matching `kind`; `"reload"` carries no extra payload.
 */
export interface CanvasEvent {
  canvasId: string;
  kind: "state" | "message" | "status" | "log" | "reload" | "focus";
  /** Set on `"focus"` events: the session whose agent called a canvas tool. */
  sessionId?: string;
  state?: unknown;
  revision?: number;
  message?: unknown;
  status?: CanvasHostStatus;
  level?: "log" | "warn" | "error";
  args?: unknown[];
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
  /** Set for a user message pushed from main (canvas send) that is queued behind a running turn. */
  queued?: boolean;
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
  /** True when the file exceeded the diff size threshold — no diff was computed. */
  tooLarge?: boolean;
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
  /** Worst-of the confidence across every `byProvider` row — `exact` when there's no usage in the range (nothing to be uncertain about). Lets the KPI card mark `periodSpendUSD` as estimated rather than presenting a total built from partial data as exact. */
  periodConfidence: CostConfidence;
  lifetimeSpendUSD: number;
  /** Same rollup as `periodConfidence`, but over the project's all-time usage rather than just `range`. */
  lifetimeConfidence: CostConfidence;
  /** Sorted by `costUSD` descending. */
  byProvider: SpendingProviderBreakdown[];
}

// ── Auto-update ─────────────────────────────────────────────────────────────

export type UpdateStatusState =
  | "idle"
  | "checking"
  | "available"
  | "not-available"
  | "downloading"
  | "downloaded"
  | "error";

/** Pushed on UPDATE_STATUS whenever electron-updater's state changes. */
export interface UpdateStatus {
  state: UpdateStatusState;
  /** Set once a newer version is known (`available` / `downloading` / `downloaded`). */
  version?: string;
  /** 0-100, set while `state === "downloading"`. */
  percent?: number;
  /** Set when `state === "error"`. */
  error?: string;
}

/** Result of UPDATE_GET_STATE — the running app's version plus the last known update status. */
export interface UpdateStateSnapshot {
  currentVersion: string;
  status: UpdateStatus;
}
