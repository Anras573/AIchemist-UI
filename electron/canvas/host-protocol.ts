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

export const CanvasToolDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  approval: z.enum(["none", "ask"]),
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

export const MainToHostMessageSchema = z.discriminatedUnion("type", [
  InitMessageSchema,
  ToolCallMessageSchema,
  UiMessageToHostSchema,
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
});

const UiMessageFromHostSchema = z.object({
  type: z.literal("ui.message"),
  message: z.unknown(),
});

const AgentSendMessageSchema = z.object({
  type: z.literal("agent.send"),
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
