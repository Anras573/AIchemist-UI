/**
 * The message protocol exchanged between the main process and a canvas host
 * process (see `host-manager.ts` for the main-process side and `host/runtime.ts`
 * for the side that runs inside the host). Narrow and zod-validated per the
 * design (#222) — a message that fails validation is dropped rather than
 * crashing either side.
 *
 * `project` (id + path) is resolved by the caller and passed to the host at
 * spawn time (argv), not over this channel — it never changes for the life of
 * a host, so there is no "which turn is this for" ambiguity to protocol for.
 */
import { z } from "zod";

/** Default tool-call timeout, overridable per tool via `CanvasTool.timeoutMs`. */
export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/** State documents are capped at 1 MB — larger data belongs in the canvas's own storage. */
export const CANVAS_STATE_MAX_BYTES = 1024 * 1024;

export const CanvasToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  approval: z.enum(["none", "ask"]),
  /** The tool's own timeout, if it overrode the host's default — used by the
   *  manager to size its safety-net timeout so it doesn't race the host's. */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * The tool's `input` zod schema, converted to JSON Schema via
   * `z.toJSONSchema()` (see `toolDescriptors()` in `host/runtime.ts`) — this
   * is what lets the model know a tool's arguments (`tools/list`'s
   * `inputSchema`) instead of guessing from the description alone (#223's
   * review). Optional/unknown-shaped rather than a nested zod schema: it
   * crosses the `MessagePort` as plain JSON, and a tool whose schema somehow
   * fails to convert falls back to a permissive schema at the endpoint
   * rather than breaking `tools/list` for every other tool on the canvas.
   */
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type CanvasToolDescriptor = z.infer<typeof CanvasToolDescriptorSchema>;

// ─── Main → Host ─────────────────────────────────────────────────────────────

const InitMessageSchema = z.object({
  type: z.literal("init"),
  /** The instance's persisted `ctx.state`, as last written to the store. */
  state: z.unknown(),
  revision: z.number().int().nonnegative(),
});

const ToolCallMessageSchema = z.object({
  type: z.literal("tool.call"),
  callId: z.string(),
  tool: z.string(),
  args: z.unknown(),
});

const UiMessageToHostSchema = z.object({
  type: z.literal("ui.message"),
  message: z.unknown(),
});

/** Main's reply to a host's `agent.send` — the ack/refusal `ctx.agent.send` awaits. */
const AgentSendResultSchema = z.object({
  type: z.literal("agent.send.result"),
  requestId: z.string(),
  ok: z.boolean(),
  error: z.string().optional(),
});

/**
 * Main's nack for a `state.changed` it failed to persist (over the store's
 * cap, or the canvas row is gone — #233). Carries the DB's authoritative
 * state/revision so the host can roll back, plus the new `epoch`: the host
 * stamps every `state.changed` with its epoch and main drops any stamped
 * lower than the current one, so writes already in flight when the rejection
 * happened (computed on top of the rejected value) can't re-drift the DB.
 */
const StateRejectedSchema = z.object({
  type: z.literal("state.rejected"),
  state: z.unknown(),
  revision: z.number().int().nonnegative(),
  epoch: z.number().int().positive(),
  error: z.string().optional(),
});

export const MainToHostMessageSchema = z.discriminatedUnion("type", [
  InitMessageSchema,
  StateRejectedSchema,
  ToolCallMessageSchema,
  UiMessageToHostSchema,
  AgentSendResultSchema,
]);
export type MainToHostMessage = z.infer<typeof MainToHostMessageSchema>;

// ─── Host → Main ─────────────────────────────────────────────────────────────

const ReadyMessageSchema = z.object({
  type: z.literal("ready"),
  tools: z.array(CanvasToolDescriptorSchema),
});

const InitErrorMessageSchema = z.object({
  type: z.literal("init.error"),
  error: z.string(),
});

/**
 * Not a `z.discriminatedUnion` on `ok` — both branches share `type:
 * "tool.result"`, and a discriminated union needs a unique literal per branch.
 * A plain object with optional `result`/`error` is validated instead; `ok`
 * decides which one a caller should read.
 */
const ToolResultMessageSchema = z.object({
  type: z.literal("tool.result"),
  callId: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
});

const StateChangedMessageSchema = z.object({
  type: z.literal("state.changed"),
  state: z.unknown(),
  revision: z.number().int().nonnegative(),
  /** Omitted while 0 (no rejection has happened yet); see `StateRejectedSchema`. */
  epoch: z.number().int().positive().optional(),
});

const UiMessageFromHostSchema = z.object({
  type: z.literal("ui.message"),
  message: z.unknown(),
});

const AgentSendMessageSchema = z.object({
  type: z.literal("agent.send"),
  requestId: z.string(),
  text: z.string(),
  sessionId: z.string().optional(),
});

const LogMessageSchema = z.object({
  type: z.literal("log"),
  level: z.enum(["log", "warn", "error"]),
  args: z.array(z.unknown()),
});

export const HostToMainMessageSchema = z.discriminatedUnion("type", [
  ReadyMessageSchema,
  InitErrorMessageSchema,
  ToolResultMessageSchema,
  StateChangedMessageSchema,
  UiMessageFromHostSchema,
  AgentSendMessageSchema,
  LogMessageSchema,
]);
export type HostToMainMessage = z.infer<typeof HostToMainMessageSchema>;
