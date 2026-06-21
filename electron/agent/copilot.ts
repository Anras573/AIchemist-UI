import type {
  CopilotClient as CopilotClientType,
  PermissionRequest,
  PermissionRequestResult,
  CustomAgentConfig,
} from "@github/copilot-sdk";
import type { Database } from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { AgentInfo, ProjectConfig } from "../../src/types/index";
import { getApiKey } from "../config";
import { parseAgentMarkdown } from "./agent-file";
import { requestApproval, requiresApproval } from "./approval";
import type { ToolCategory } from "./approval";
import { requestQuestion } from "./question";
import { buildSkillsContext } from "./skills";
import { buildMemoryContext, implDeleteMemory, implReadMemory, implWriteMemory } from "./memory";
import { readAgentFileSystemPrompt } from "./claude";
import { classifyNativeTool, runGatedTool } from "./tool-gate";
import type { GatedToolContext } from "./tool-gate";
import { TurnEmitter } from "./turn-emitter";
import {
  loadManagedMcpServers,
  toCopilotMcpServers,
  fingerprintManaged,
} from "../mcp";
import { saveToolCall, updateToolCallStatus, getDisabledMcpServers } from "../sessions";
import { providerSessionStore } from "./provider-session-store";
import {
  implWriteFileWithChange,
  implDeleteFileWithChange,
  implExecuteBash,
  implWebFetch,
} from "./tool-impls";
import type { AgentProvider, AgentProviderParams } from "./provider";

// ── Native tool category helper ───────────────────────────────────────────────

/** Maps Copilot native tool names (case-insensitive) onto approval categories. */
const COPILOT_TOOL_RULES = {
  shell: ["bash", "run_shell"],
  web: ["web_fetch", "web_search", "browser"],
  normalize: (name: string) => name.toLowerCase(),
} as const;

function nativeToolCategory(name: string): ToolCategory {
  return classifyNativeTool(name, COPILOT_TOOL_RULES) ?? "filesystem";
}

// ── Singleton client ──────────────────────────────────────────────────────────

let clientInstance: CopilotClientType | null = null;

async function getClient(): Promise<CopilotClientType> {
  if (clientInstance) return clientInstance;
  const { CopilotClient } = await import("@github/copilot-sdk");
  const githubToken = getApiKey("github") ?? undefined;
  const client = new CopilotClient({ gitHubToken: githubToken });
  await client.start();
  clientInstance = client;
  return client;
}

/** Gracefully stop the shared Copilot CLI client. */
export async function stopCopilotClient(): Promise<void> {
  if (clientInstance) {
    await clientInstance.stop();
    clientInstance = null;
    // The SDK sessions held in memory are gone with the client; drop the
    // read-through cache so the next turn re-reads from the DB and falls back to
    // a fresh session if a resume fails.
    providerSessionStore.reset();
  }
}

/** Return the list of models available for the authenticated Copilot user. */
export async function getCopilotModels(): Promise<Array<{ id: string; name: string }>> {
  const client = await getClient();
  const models = await client.listModels();
  return models.map((m) => ({ id: m.id, name: m.name }));
}

// ── Agent scanning ────────────────────────────────────────────────────────────

type CopilotAgentEntry = { name: string; description: string; prompt: string; model?: string; filePath: string };
type CopilotAgentParsed = Omit<CopilotAgentEntry, "filePath">;

/** Parse a Copilot agent markdown file's YAML frontmatter + body. */
function parseCopilotAgentFile(content: string): CopilotAgentParsed | null {
  const parsed = parseAgentMarkdown(content);
  // The body becomes the agent's system prompt — must be non-empty
  if (!parsed?.name || !parsed.body) return null;
  return {
    name: parsed.name,
    description: parsed.description,
    prompt: parsed.body,
    ...(parsed.model ? { model: parsed.model } : {}),
  };
}

/** Scan a directory for `*.md` agent files and return parsed entries. */
function scanAgentDir(dir: string): CopilotAgentEntry[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith(".md"))
      .flatMap((file) => {
        try {
          const filePath = path.join(dir, file.name);
          const content = fs.readFileSync(filePath, "utf8");
          const entry = parseCopilotAgentFile(content);
          return entry ? [{ ...entry, filePath }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * Returns available Copilot sub-agents by merging:
 * 1. Project-local agents: `{projectPath}/.agents/copilot-agents/*.md`
 * 2. Global agents: `~/.github-copilot/agents/*.md`
 *
 * Project-local agents take priority over globals with the same name.
 */
export function listCopilotAgents(projectPath: string): AgentInfo[] {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");

  const projectEntries = scanAgentDir(projectDir);
  const globalEntries = scanAgentDir(globalDir);

  const projectNames = new Set(projectEntries.map((a) => a.name));
  const merged = [
    ...projectEntries,
    ...globalEntries.filter((a) => !projectNames.has(a.name)),
  ];

  return merged.map(({ name, description, filePath }) => {
    const source = projectEntries.some((e) => e.name === name) ? "project" : "global";
    return { name, description, path: filePath, editable: true, source } as const;
  });
}

/** Convert scanned agent entries to CustomAgentConfig objects for the SDK. */
function toCustomAgentConfigs(projectPath: string): CustomAgentConfig[] {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");

  const projectEntries = scanAgentDir(projectDir);
  const globalEntries = scanAgentDir(globalDir);

  const projectNames = new Set(projectEntries.map((a) => a.name));
  return [
    ...projectEntries,
    ...globalEntries.filter((a) => !projectNames.has(a.name)),
  ].map(({ name, description, prompt }) => ({
    name,
    displayName: name,
    description,
    prompt,
  }));
}

/**
 * Find a Copilot agent by name and return its prompt body + optional `model:`
 * override. Searches project-local agents first, then global agents.
 */
function findCopilotAgent(
  agentName: string,
  projectPath: string,
): { prompt: string; model?: string } | null {
  const projectDir = path.join(projectPath, ".agents", "copilot-agents");
  const globalDir = path.join(os.homedir(), ".github-copilot", "agents");
  for (const dir of [projectDir, globalDir]) {
    for (const entry of scanAgentDir(dir)) {
      if (entry.name === agentName) return { prompt: entry.prompt, model: entry.model };
    }
  }
  return null;
}

/**
 * Resolve a selected agent's system-prompt body and optional `model:` override.
 * Lookup order: Copilot agent files → Claude agent files (cross-provider, e.g.
 * agents selected via the Command Palette which merges both providers). The
 * model is taken from whichever file supplied the body.
 */
export function resolveSelectedAgent(
  agentName: string,
  projectPath: string,
): { body: string | null; model?: string } {
  const copilotAgent = findCopilotAgent(agentName, projectPath);
  if (copilotAgent) return { body: copilotAgent.prompt, model: copilotAgent.model };
  const claudeAgent = readAgentFileSystemPrompt(agentName);
  return { body: claudeAgent?.body ?? null, model: claudeAgent?.model };
}

// ── System message composition ──────────────────────────────────────────────────

/**
 * Steer Copilot to the in-Electron `ask_user` tool instead of asking in plain
 * text (the native CLI question UI is unavailable in this app).
 */
const ASK_USER_INSTRUCTION =
  "\n\nWhen a task is ambiguous or could reasonably be interpreted multiple ways, " +
  "always call the `ask_user` tool before proceeding rather than making assumptions or asking questions in plain text. " +
  "Never ask the user a question by writing it in your response — always use the `ask_user` tool instead. " +
  "The `ask_user` tool supports an `options` array of short choices the user can click; " +
  "always provide relevant options when there are distinct alternatives to choose from.";

/**
 * Tell Copilot the project-memory tools exist. Unlike the saved-notes block from
 * `buildMemoryContext()` (which is empty until something is written), this is
 * always present so the model knows it *can* start persisting memory.
 */
const MEMORY_INSTRUCTION =
  "\n\nUse the write_memory tool to persist durable facts about this project " +
  "(conventions, decisions, gotchas) so they survive across turns, read_memory to recall " +
  "a saved note, and delete_memory to remove one that is no longer accurate.";

/**
 * Compose the Copilot `systemMessage` content + mode from the resolved agent
 * body, the active skills context, and the project memory context.
 *
 * - With an agent body → `replace` mode (the agent's instructions ARE the
 *   primary context); skills, the memory tool instruction + saved notes, and the
 *   `ask_user` instruction are appended after it.
 * - Without one (default Copilot prompt, or an agent that wasn't found) →
 *   `append` mode so the memory + `ask_user` instructions augment Copilot's own
 *   prompt. (Skills, when present, are injected via `customAgents` instead in
 *   that path, so they are not included here.)
 *
 * `noTools` (text-only generation turns, e.g. PR-draft) drops the tool guidance:
 * those sessions are created with `tools: []` and reject every permission, so
 * telling the model to call `ask_user` / the memory tools would only invite
 * failed tool calls. The read-only saved-notes block is still appended as
 * context — it references no unavailable tool.
 *
 * NOTE: the saved-notes block changes whenever memory is written, but memory is
 * deliberately NOT part of the resume-invalidation fingerprint (see the
 * "customAgents vs systemMessage" footgun in CLAUDE.md). `resumeSession` ignores
 * an updated systemMessage, so folding memory into the fingerprint would force a
 * fresh `createSession` — and lose conversation history — on every memory write.
 * Instead, within a session the model's own writes are already in history, and
 * `read_memory` recalls anything on demand; a fresh injection only happens when
 * the session is recreated for another reason (agent / MCP change, app restart).
 * This mirrors how `skillsContext` is already injected without churning resumes.
 */
export function composeCopilotSystemMessage(opts: {
  agentBody: string | null;
  skillsContext: string;
  memoryContext: string;
  noTools?: boolean;
}): { content: string; mode: "replace" | "append" } {
  const { agentBody, skillsContext, memoryContext, noTools } = opts;
  const toolGuidance = noTools ? "" : MEMORY_INSTRUCTION + ASK_USER_INSTRUCTION;
  const augmentation = toolGuidance + memoryContext;
  if (agentBody) {
    return { content: agentBody + skillsContext + augmentation, mode: "replace" };
  }
  return { content: augmentation, mode: "append" };
}

// ── Agent turn ────────────────────────────────────────────────────────────────

export async function runCopilotAgentTurn(params: {
  db: Database;
  sessionId: string;
  messageId: string;
  prompt: string;
  projectPath: string;
  projectConfig: ProjectConfig;
  webContents: Electron.WebContents;
  agent?: string;
  skills?: string[];
  noTools?: boolean;
}): Promise<string> {
  const { db, sessionId, messageId, prompt, projectPath, projectConfig, webContents, agent, skills, noTools } = params;

  const { defineTool } = await import("@github/copilot-sdk");

  const client = await getClient();

  const emitter = new TurnEmitter(webContents, sessionId);
  const gateCtx: GatedToolContext = { db, sessionId, messageId, projectConfig, emitter };

  // ── Tool definitions ────────────────────────────────────────────────────────

  const writeFileTool = defineTool<{ path: string; content: string }>(
    "write_file",
    {
      description: "Write content to a file, creating parent directories as needed.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "Content to write" },
        },
        required: ["path", "content"],
      },
      handler: (args) =>
        runGatedTool(gateCtx, {
          name: "write_file",
          args,
          category: "filesystem",
          onError: "throw",
          impl: async () => {
            const { result, change } = await implWriteFileWithChange(args, projectPath);
            if (change) emitter.fileChange(change);
            return result;
          },
        }),
    }
  );

  const deleteFileTool = defineTool<{ path: string }>("delete_file", {
    description: "Delete a file from the filesystem.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute or relative path of the file to delete" },
      },
      required: ["path"],
    },
    handler: (args) =>
      runGatedTool(gateCtx, {
        name: "delete_file",
        args,
        category: "filesystem",
        onError: "throw",
        impl: async () => {
          const { result, change } = await implDeleteFileWithChange(args, projectPath);
          if (change) emitter.fileChange(change);
          return result;
        },
      }),
  });

  const executeBashTool = defineTool<{ command: string; cwd?: string }>(
    "execute_bash",
    {
      description: "Execute a shell command and return its output. Always requires approval.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
          cwd: { type: "string", description: "Working directory for the command" },
        },
        required: ["command"],
      },
      handler: (args) =>
        runGatedTool(gateCtx, {
          name: "execute_bash",
          args,
          category: "shell",
          onError: "throw",
          impl: () => implExecuteBash({ ...args, projectPath }),
        }),
    }
  );

  const webFetchTool = defineTool<{ url: string }>("web_fetch", {
    description: "Fetch a URL via HTTP GET and return its content.",
    // web_fetch is also a Copilot CLI built-in; override it so our version
    // handles the call (gives us IPC visibility + approval gating).
    overridesBuiltInTool: true,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
    handler: (args) =>
      runGatedTool(gateCtx, {
        name: "web_fetch",
        args,
        category: "web",
        onError: "throw",
        impl: () => implWebFetch(args),
      }),
  });

  const askUserTool = defineTool<{ question: string; options?: string[]; placeholder?: string }>(
    "ask_user",
    {
      description:
        "Ask the user a question and wait for their answer before proceeding. Use when you need clarification, missing information, or a decision from the user.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The question to ask the user" },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of pre-defined choices the user can click",
          },
          placeholder: { type: "string", description: "Placeholder text for the free-form input field" },
        },
        required: ["question"],
      },
      handler: async (args) => {
        const answer = await requestQuestion(
          webContents,
          sessionId,
          args.question,
          args.options,
          args.placeholder
        );
        return answer || "(no answer provided)";
      },
    }
  );

  // ── Project memory tools ──────────────────────────────────────────────────────
  // The model's own scratchpad, stored at ~/.aichemist/memory/<cwd>/*.md (the
  // SAME store the self-driven providers use, so memory is portable across
  // providers for a project). Category "custom" keeps them un-gated and they
  // emit NO FileChange — they are not project edits and stay out of the Changes
  // tab. The store lives outside the project root, so the project-boundary FS
  // validators in tool-impls.ts cannot be reused; memory.ts carries its own.

  const writeMemoryTool = defineTool<{ name: string; content: string }>("write_memory", {
    description:
      "Persist a durable note about this project to AIchemist's project memory so it is " +
      "available in future turns. Use for conventions, decisions, and gotchas. " +
      "Overwrites the named memory file if it already exists.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Memory file name (a flat '.md' filename)" },
        content: { type: "string", description: "Markdown content to save" },
      },
      required: ["name", "content"],
    },
    handler: (args) =>
      runGatedTool(gateCtx, {
        name: "write_memory",
        args,
        category: "custom",
        onError: "throw",
        impl: async () => implWriteMemory(projectPath, args.name, args.content),
      }),
  });

  const readMemoryTool = defineTool<{ name: string }>("read_memory", {
    description: "Read back a previously saved project memory note by name.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Memory file name (a flat '.md' filename)" },
      },
      required: ["name"],
    },
    handler: (args) =>
      runGatedTool(gateCtx, {
        name: "read_memory",
        args,
        category: "custom",
        onError: "throw",
        impl: async () => implReadMemory(projectPath, args.name),
      }),
  });

  const deleteMemoryTool = defineTool<{ name: string }>("delete_memory", {
    description: "Delete a saved project memory note that is no longer accurate.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Memory file name (a flat '.md' filename)" },
      },
      required: ["name"],
    },
    handler: (args) =>
      runGatedTool(gateCtx, {
        name: "delete_memory",
        args,
        category: "custom",
        onError: "throw",
        impl: async () => implDeleteMemory(projectPath, args.name),
      }),
  });

  // ── Permission handler for built-in CLI tools ───────────────────────────────
  // Our custom defineTool handlers gate approval themselves; this handles the
  // CLI's built-in tools (read_file, edit_file, run_shell, etc.).
  const onPermissionRequest = async (
    request: PermissionRequest
  ): Promise<PermissionRequestResult> => {
    let category: "filesystem" | "shell" | "web" | null = null;

    switch (request.kind) {
      case "shell":
        category = "shell";
        break;
      case "write":
      case "read":
      case "mcp":
        category = "filesystem";
        break;
      case "url":
        category = "web";
        break;
      case "custom-tool":
        // Custom defineTool handlers manage their own approval gate
        return { kind: "approve-once" };
    }

    if (category === null) return { kind: "approve-once" };

    // Shell operations and others depend on project config and allowlists
    const shouldGate = requiresApproval(sessionId, projectConfig, category, request.kind, request);

    if (!shouldGate) return { kind: "approve-once" };

    const approved = await requestApproval(
      webContents,
      sessionId,
      request.kind,
      request
    );

    return approved
      ? { kind: "approve-once" }
      : { kind: "reject" };
  };

  // ── Create or resume session ────────────────────────────────────────────────

  const skillsContext = buildSkillsContext(skills ?? [], projectPath);
  // Project memory (~/.aichemist/memory/<cwd>) — the same store the self-driven
  // providers read, folded into the systemMessage. See composeCopilotSystemMessage
  // for why memory is deliberately kept out of the resume-invalidation fingerprint.
  // In noTools (text-only) turns the memory tools aren't registered, so strip the
  // "Use write_memory …" guidance from the block too — otherwise the model is told
  // to call a tool that will be rejected. The saved notes themselves stay as context.
  const memoryContext = buildMemoryContext(projectPath, { includeToolGuidance: !noTools });

  // When a specific agent is selected, inject its system prompt via `systemMessage`
  // using replace mode so the agent's instructions ARE the primary context.
  // Lookup order: Copilot agent files → Claude agent files (cross-provider, e.g.
  // agents selected via Command Palette which merges both providers).
  let systemMessageContent: string | null = null;
  let systemMessageMode: "replace" | "append" = "replace";
  let customAgents: CustomAgentConfig[] = [];
  // A selected agent's `model:` frontmatter overrides the session model for this
  // turn. Lookup order mirrors the body lookup: Copilot agent files → Claude
  // agent files.
  let agentModelOverride: string | undefined;

  // Resolve the selected agent (if any) up front so its `model:` override is
  // honoured even when the body can't be loaded.
  const selected = agent ? resolveSelectedAgent(agent, projectPath) : null;
  agentModelOverride = selected?.model;

  if (selected?.body) {
    // Agent found → its instructions ARE the primary context (replace mode), with
    // skills + memory + the ask_user instruction appended.
    const composed = composeCopilotSystemMessage({
      agentBody: selected.body,
      skillsContext,
      memoryContext,
      noTools,
    });
    systemMessageContent = composed.content;
    systemMessageMode = composed.mode;
  } else {
    // No agent selected, OR a selected agent that couldn't be resolved. Either
    // way, degrade to the default path so oneshot skills and configured Copilot
    // sub-agents are still injected (via customAgents) rather than silently
    // dropped — a missing agent should behave like "no agent selected".
    if (agent) {
      console.warn(`[copilot] Agent "${agent}" not found — falling back to the default system prompt`);
    }
    customAgents = toCustomAgentConfigs(projectPath);
    if (skillsContext) {
      if (customAgents.length > 0) {
        customAgents = customAgents.map((a) => ({ ...a, prompt: a.prompt + skillsContext }));
      } else {
        customAgents = [{ name: "_skills", description: "Active skills context", prompt: skillsContext }];
      }
    }
    // Append the memory + ask_user instructions to Copilot's default system prompt.
    const composed = composeCopilotSystemMessage({
      agentBody: null,
      skillsContext,
      memoryContext,
      noTools,
    });
    systemMessageContent = composed.content;
    systemMessageMode = composed.mode;
  }

  // Load AIchemist-managed MCP servers (~/.aichemist/mcp.json) and compute a
  // fingerprint we'll use to detect mid-session changes that require a fresh
  // SDK session (resumeSession does NOT honour an updated mcpServers map).
  // Per-session disabled servers are filtered out BEFORE fingerprinting so
  // toggling a server off naturally invalidates the cached SDK session.
  // Skipped entirely when noTools is true (text-only generation turns).
  const managedMcpRaw = noTools
    ? {}
    : loadManagedMcpServers({ excludeNames: new Set(getDisabledMcpServers(db, sessionId)) });
  const mcpFingerprint = fingerprintManaged(managedMcpRaw);

  const sessionConfig = {
    model: agentModelOverride?.trim() || projectConfig.model,
    streaming: true,
    workingDirectory: projectPath,
    // When noTools is true, omit all custom tool definitions and block all
    // built-in CLI tool permissions so the model cannot perform side-effects.
    tools: noTools
      ? []
      : [
          writeFileTool,
          deleteFileTool,
          executeBashTool,
          webFetchTool,
          askUserTool,
          writeMemoryTool,
          readMemoryTool,
          deleteMemoryTool,
        ],
    onPermissionRequest: noTools
      ? () => Promise.resolve({ kind: "reject" as const })
      : onPermissionRequest,
    ...(systemMessageContent ? { systemMessage: { mode: systemMessageMode, content: systemMessageContent } } : {}),
    ...(customAgents.length > 0 ? { customAgents } : {}),
    // AIchemist-managed MCP servers (~/.aichemist/mcp.json), injected per-session
    // so they don't pollute Copilot CLI's global ~/.copilot/mcp-config.json.
    // Omitted when noTools is true.
    ...(!noTools && Object.keys(managedMcpRaw).length > 0
      ? { mcpServers: toCopilotMcpServers(managedMcpRaw) }
      : {}),
  };

  // Load the prior Copilot SDK state (read-through cache, seeded from the DB on
  // first access so sessions survive app restarts). Both sides of every
  // comparison below come from this single DB-backed blob, so the old
  // in-memory/DB normalization footgun no longer exists.
  let prior = providerSessionStore.get(db, sessionId, "copilot") ?? {};

  // Legacy fallback: sessions that last ran before the provider_state migration
  // carry their SDK session id / agent / MCP fingerprint in the old
  // copilot_session_* columns. Read them once, backfill provider_state, and
  // clear the legacy columns so the fallback is truly one-time — otherwise a
  // later invalidation (slice removed via set(…, null)) would resurrect the
  // stale state from the still-populated columns.
  if (!prior.sessionId) {
    const legacy = db
      .prepare(
        "SELECT copilot_session_id, copilot_session_agent, copilot_session_mcp_fp FROM sessions WHERE id = ?"
      )
      .get(sessionId) as
      | {
          copilot_session_id: string | null;
          copilot_session_agent: string | null;
          copilot_session_mcp_fp: string | null;
        }
      | undefined;
    if (legacy?.copilot_session_id) {
      prior = {
        sessionId: legacy.copilot_session_id,
        agent: legacy.copilot_session_agent,
        mcpFp: legacy.copilot_session_mcp_fp,
      };
      providerSessionStore.set(db, sessionId, "copilot", prior);
      db.prepare(
        "UPDATE sessions SET copilot_session_id = NULL, copilot_session_agent = NULL, copilot_session_mcp_fp = NULL WHERE id = ?"
      ).run(sessionId);
    }
  }

  const normalizedAgent = agent ?? "";
  const normalizedMcpFp = mcpFingerprint ?? "";

  // If the agent OR the managed-MCP fingerprint changed since the last turn, the
  // old SDK session was created with a stale systemMessage / mcpServers map.
  // resumeSession ignores both, so we must force a fresh session.
  let resumeId = prior.sessionId ?? null;
  if (
    resumeId &&
    ((prior.agent ?? "") !== normalizedAgent || (prior.mcpFp ?? "") !== normalizedMcpFp)
  ) {
    resumeId = null;
  }

  // Resume the existing Copilot SDK session for this AIchemist session (if any)
  // so conversation history is preserved across turns and app restarts.
  // Fall back to creating a new session if no prior session exists or resuming fails.
  let session: Awaited<ReturnType<typeof client.createSession>>;
  if (resumeId) {
    try {
      session = await client.resumeSession(resumeId, sessionConfig);
    } catch {
      // Session state was lost (e.g. server expiry) — create fresh.
      session = await client.createSession(sessionConfig);
    }
  } else {
    session = await client.createSession(sessionConfig);
  }

  // Persist the resolved state (write-through to the DB) so the next turn and
  // future app runs resume the same SDK session with the same agent / MCP map.
  providerSessionStore.set(db, sessionId, "copilot", {
    sessionId: session.sessionId,
    agent: normalizedAgent || null,
    mcpFp: normalizedMcpFp || null,
  });

  // ── Event listeners — set up before sending ─────────────────────────────────

  // Names of our custom defineTool handlers — they already send their own TOOL_CALL/RESULT events
  const customToolNames = new Set([
    "execute_bash",
    "write_file",
    "delete_file",
    "web_fetch",
    "ask_user",
    "write_memory",
    "read_memory",
    "delete_memory",
  ]);

  // Track toolCallId → toolName for built-in tools (tool.execution_complete has no toolName)
  const toolCallIdToName = new Map<string, string>();

  let fullText = "";
  let turnOutputTokens = 0;
  const done = new Promise<void>((resolve, reject) => {
    // The SDK emits "assistant.message" each time the accumulated text grows
    // (streaming). Track previous length to compute incremental deltas.
    session.on("assistant.message", (event) => {
      const data = event.data as { content: string; outputTokens?: number };
      const newText: string = data.content ?? "";
      const delta = newText.slice(fullText.length);
      fullText = newText;
      if (delta) {
        emitter.delta(delta);
      }
      if (data.outputTokens != null) {
        turnOutputTokens = data.outputTokens;
        emitter.usage({
          input_tokens: 0,
          output_tokens: turnOutputTokens,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        });
      }
    });

    // Track tool execution start for built-in CLI tools
    session.on("tool.execution_start", (event) => {
      const data = event.data as {
        toolCallId: string;
        toolName: string;
        arguments?: Record<string, unknown>;
      };
      toolCallIdToName.set(data.toolCallId, data.toolName);
      if (!customToolNames.has(data.toolName)) {
        emitter.toolCall(data.toolCallId, data.toolName, data.arguments ?? {});
        saveToolCall(db, {
          id: data.toolCallId,
          messageId,
          name: data.toolName,
          args: data.arguments ?? {},
          status: "approved",
          category: nativeToolCategory(data.toolName),
        });
      }
    });

    // Capture results for built-in CLI tools
    session.on("tool.execution_complete", (event) => {
      const data = event.data as {
        toolCallId: string;
        success: boolean;
        result?: {
          content: string;
          detailedContent?: string;
          contents?: Array<
            | { type: "text"; text: string }
            | { type: "terminal"; text: string; exitCode?: number }
          >;
        };
      };
      const toolName = toolCallIdToName.get(data.toolCallId) ?? "unknown";
      if (!customToolNames.has(toolName)) {
        // Prefer terminal content blocks, then detailedContent, then content
        const terminalBlock = data.result?.contents?.find((c) => c.type === "terminal");
        const output = terminalBlock
          ? (terminalBlock as { type: "terminal"; text: string }).text
          : (data.result?.detailedContent ?? data.result?.content ?? "");
        updateToolCallStatus(db, data.toolCallId, data.success ? "complete" : "error", output);
        emitter.toolResult(toolName, output);
      }
    });

    // Compaction events — emitted by the SDK when context window is managed
    session.on("session.compaction_complete", (event) => {
      const data = event.data as {
        success: boolean;
        preCompactionTokens?: number;
        tokensRemoved?: number;
      };
      if (data.success) {
        emitter.compaction({
          id: `compaction-${Date.now()}`,
          timestamp: new Date().toISOString(),
          trigger: "auto",
          pre_tokens: data.preCompactionTokens ?? 0,
        });
      }
    });

    // Reasoning / extended thinking events
    session.on("assistant.reasoning_delta", (event) => {
      const data = event.data as { reasoningId: string; deltaContent: string };
      emitter.thinkingDelta(data.deltaContent);
    });

    session.on("assistant.reasoning", () => {
      emitter.thinkingDone();
    });

    session.on("session.idle", () => resolve());
    session.on("session.error", (event) => {
      reject(new Error((event.data as { message: string }).message ?? "Copilot session error"));
    });
    session.on("session.shutdown", () => reject(new Error("Copilot session aborted")));
  });

  // ── Send & wait ─────────────────────────────────────────────────────────────

  try {
    emitter.status("running");

    await session.send({ prompt });
    await done;

    emitter.status("complete");
  } catch (err) {
    emitter.status("error");
    throw err;
  } finally {
    await session.disconnect();
  }

  return fullText;
}

// ── AgentProvider implementation ──────────────────────────────────────────────

export const copilotProvider: AgentProvider = {
  run: (params: AgentProviderParams) => runCopilotAgentTurn(params),

  async listModels(): Promise<Array<{ id: string; name: string }>> {
    return getCopilotModels();
  },

  async listAgents(projectPath: string): Promise<AgentInfo[]> {
    return listCopilotAgents(projectPath);
  },

  async stop(): Promise<void> {
    return stopCopilotClient();
  },
};
