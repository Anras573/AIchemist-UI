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

/** The delete channels take a bare path string rather than an options object. */
const pathArgSchema = z.string().min(1);

/**
 * Per-channel argument validators. Keyed by channel constant so a new mutation
 * channel can opt in with one entry.
 */
export const validators: Partial<Record<RequestChannel, (args: unknown[]) => void>> = {
  [CH.AGENT_SEND]: (args) => check(agentSendSchema, args[0], CH.AGENT_SEND),
  [CH.SAVE_MESSAGE]: (args) => check(saveMessageSchema, args[0], CH.SAVE_MESSAGE),
  [CH.WRITE_AGENT_FILE]: (args) => check(writeAgentFileSchema, args[0], CH.WRITE_AGENT_FILE),
  [CH.WRITE_SKILL_FILE]: (args) => check(writeSkillFileSchema, args[0], CH.WRITE_SKILL_FILE),
  [CH.CREATE_AGENT]: (args) => check(createAgentSchema, args[0], CH.CREATE_AGENT),
  [CH.DELETE_AGENT_FILE]: (args) => check(pathArgSchema, args[0], CH.DELETE_AGENT_FILE),
  [CH.CREATE_SKILL]: (args) => check(createSkillSchema, args[0], CH.CREATE_SKILL),
  [CH.DELETE_SKILL_DIR]: (args) => check(pathArgSchema, args[0], CH.DELETE_SKILL_DIR),
};
