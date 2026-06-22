/**
 * Optional zod validation for the mutation channels. The renderer is
 * `contextBridge`-isolated but not *trusted* — a compromised or buggy renderer
 * could send a malformed payload — so the highest-impact mutations (agent send,
 * file writes, message persistence) validate their wire args at the boundary.
 *
 * A validator receives the raw `args` array `ipcRenderer.invoke` delivered and
 * throws an {@link IpcError} with code `invalid_input` on failure. `handle()`
 * runs the matching validator (if any) before the handler. Channels without an
 * entry are not validated.
 */
import { z } from "zod";
import type { RequestChannel } from "../ipc-contract";
import * as CH from "../ipc-channels";
import { IpcError } from "./errors";
import { isValidCron } from "../cron";
import { isProviderId } from "../providers";

/** Parses `schema` against `value`, rethrowing zod issues as a structured IpcError. */
function check<T>(schema: z.ZodType<T>, value: unknown, channel: string): void {
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new IpcError("invalid_input", `Invalid arguments for "${channel}": ${detail}`);
  }
}

/**
 * Builds a validator for a single-argument channel. It enforces the unary arity
 * (every validated channel takes exactly one wire arg — an object payload or a
 * path string) so a renderer sending extra parameters is rejected, then runs
 * `schema` against that argument.
 */
function unary<T>(schema: z.ZodType<T>, channel: string): (args: unknown[]) => void {
  return (args) => {
    if (args.length !== 1) {
      throw new IpcError("invalid_input", `"${channel}" expects exactly one argument, got ${args.length}`);
    }
    check(schema, args[0], channel);
  };
}

const agentSendSchema = z.object({
  sessionId: z.string().min(1),
  prompt: z.string(),
  agent: z.string().min(1).optional(),
  oneshotSkills: z.array(z.string().min(1)).optional(),
  skipPersistence: z.boolean().optional(),
  messageId: z.string().min(1).optional(),
});

const saveMessageSchema = z.object({
  sessionId: z.string().min(1),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
});

const writeAgentFileSchema = z.object({
  filePath: z.string().min(1),
  content: z.string(),
});

const writeSkillFileSchema = z.object({
  skillPath: z.string().min(1),
  content: z.string(),
});

const createAgentSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  projectPath: z.string().min(1),
  scope: z.enum(["global", "project"]),
  content: z.string(),
});

const createSkillSchema = z.object({
  name: z.string().min(1),
  projectPath: z.string().min(1),
  scope: z.enum(["global", "project"]),
  content: z.string(),
  provider: z.string().min(1).optional(),
});

// A workflow can schedule autonomous filesystem/shell work, so its upsert is a
// high-impact mutation. An unparseable cron must never reach the store (it would
// later fail to arm), so reject it here via `croner`. `null`/absent = manual-only.
const workflowUpsertSchema = z.object({
  // `.trim().min(1)` (on every free-text id/field below) rejects whitespace-only
  // values ("   ") at the boundary — `min(1)` alone only checks length, which
  // would let a caller persist a blank id / unusable workflow.
  id: z.string().trim().min(1).optional(),
  projectId: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  prompt: z.string().trim().min(1).optional(),
  // Re-validate the provider against the canonical PROVIDER_IDS list (matching
  // session-handlers' isProviderId() guard) so an untrusted renderer can't
  // persist a row with an unknown provider the scheduler would later choke on.
  provider: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .refine((v) => v == null || isProviderId(v), { message: "is not a known provider" }),
  model: z.string().trim().min(1).nullable().optional(),
  agent: z.string().trim().min(1).nullable().optional(),
  skills: z.array(z.string().trim().min(1)).nullable().optional(),
  cron: z
    .string()
    .nullable()
    .optional()
    .refine((v) => v == null || isValidCron(v), { message: "is not a valid cron expression" }),
  // A filesystem path to watch (file-driven trigger). We only reject a
  // whitespace-only value here — existence isn't required at save time (the path
  // may be created later), and the watcher arms fail-safe if it can't be watched.
  watchPath: z.string().trim().min(1).nullable().optional(),
  enabled: z.boolean().optional(),
  sessionStrategy: z.enum(["fresh", "reuse"]).optional(),
  reuseSessionId: z.string().trim().min(1).nullable().optional(),
  autonomy: z.enum(["interactive", "autonomous"]).optional(),
});

const workflowRunNowSchema = z.object({
  workflowId: z.string().trim().min(1),
});

const workflowDeleteSchema = z.object({
  workflowId: z.string().trim().min(1),
});

const workflowListRunsSchema = z.object({
  workflowId: z.string().trim().min(1),
});

/** The delete channels take a bare path string rather than an options object. */
const pathArgSchema = z.string().min(1);

/**
 * Per-channel argument validators. Keyed by channel constant so a new mutation
 * channel can opt in with one entry.
 */
export const validators: Partial<Record<RequestChannel, (args: unknown[]) => void>> = {
  [CH.AGENT_SEND]: unary(agentSendSchema, CH.AGENT_SEND),
  [CH.SAVE_MESSAGE]: unary(saveMessageSchema, CH.SAVE_MESSAGE),
  [CH.WRITE_AGENT_FILE]: unary(writeAgentFileSchema, CH.WRITE_AGENT_FILE),
  [CH.WRITE_SKILL_FILE]: unary(writeSkillFileSchema, CH.WRITE_SKILL_FILE),
  [CH.CREATE_AGENT]: unary(createAgentSchema, CH.CREATE_AGENT),
  [CH.DELETE_AGENT_FILE]: unary(pathArgSchema, CH.DELETE_AGENT_FILE),
  [CH.CREATE_SKILL]: unary(createSkillSchema, CH.CREATE_SKILL),
  [CH.DELETE_SKILL_DIR]: unary(pathArgSchema, CH.DELETE_SKILL_DIR),
  [CH.WORKFLOW_UPSERT]: unary(workflowUpsertSchema, CH.WORKFLOW_UPSERT),
  [CH.WORKFLOW_RUN_NOW]: unary(workflowRunNowSchema, CH.WORKFLOW_RUN_NOW),
  [CH.WORKFLOW_DELETE]: unary(workflowDeleteSchema, CH.WORKFLOW_DELETE),
  [CH.WORKFLOW_LIST_RUNS]: unary(workflowListRunsSchema, CH.WORKFLOW_LIST_RUNS),
};
