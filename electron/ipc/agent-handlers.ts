import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import { getSession } from "../sessions";
import { listProjects, getProjectConfig, saveProjectConfig } from "../projects";
import { runAgentTurn, getProvider } from "../agent/runner";
import {
  resolveApproval,
  getPendingApprovalData,
  addToSessionAllowlist,
  computeFingerprint,
} from "../agent/approval";
import { resolveQuestion } from "../agent/question";
import { getIssue } from "../github";
import { handle } from "./handle";

// ── Frontmatter / skill scanning helpers ─────────────────────────────────────

function parseFrontmatterField(content: string, field: string): string {
  const singleLine = content.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  const value = singleLine?.[1]?.trim() ?? "";

  if (/^[|>][-+]?$/.test(value)) {
    const blockMatch = content.match(
      new RegExp(`^${field}:\\s*[|>][-+]?\\s*\\n((?:[ \\t]+.+\\n?)+)`, "m")
    );
    if (blockMatch) {
      return blockMatch[1]
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ");
    }
    return "";
  }

  return value;
}

function scanSkillsDir(
  dir: string,
  source: "project" | "global"
): Array<{ name: string; description: string; path: string; source: "project" | "global" }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((d) => {
        const skillPath = path.join(dir, d.name);
        let description = "";
        try {
          const content = fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
          description = parseFrontmatterField(content, "description").slice(0, 150);
        } catch {
          try {
            const content = fs.readFileSync(path.join(skillPath, "README.md"), "utf8");
            for (const line of content.split("\n")) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith("#")) {
                description = trimmed.slice(0, 150);
                break;
              }
            }
          } catch {
            // no README either — description stays empty
          }
        }
        return { name: d.name, description, path: skillPath, source };
      });
  } catch {
    return [];
  }
}

interface PluginSkillsCache {
  timestamp: number;
  mtime: number;
  results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }>;
}
let pluginSkillsCache: PluginSkillsCache | null = null;
const PLUGIN_SKILLS_CACHE_TTL_MS = 30_000;

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function scanPluginSkills(): Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> {
  const pluginsFile = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");

  try {
    const stats = fs.statSync(pluginsFile);
    const mtime = stats.mtimeMs;
    const now = Date.now();

    if (
      pluginSkillsCache !== null &&
      pluginSkillsCache.mtime === mtime &&
      now - pluginSkillsCache.timestamp < PLUGIN_SKILLS_CACHE_TTL_MS
    ) {
      return pluginSkillsCache.results;
    }

    const data = JSON.parse(fs.readFileSync(pluginsFile, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string; lastUpdated?: string }>>;
    };

    const results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> = [];
    const seen = new Set<string>();
    let hadPartialReadError = false;

    for (const [pluginKey, entries] of Object.entries(data.plugins)) {
      const sorted = [...entries].sort((a, b) =>
        (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "")
      );
      const installPath = sorted[0]?.installPath;
      if (!installPath) continue;

      const skillsDir = path.join(installPath, "skills");
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPathError(error)) {
          hadPartialReadError = true;
        }
        continue;
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch (error) {
          if (!isMissingPathError(error)) {
            hadPartialReadError = true;
          }
          continue;
        }

        const name = parseFrontmatterField(content, "name") || entry.name;
        if (seen.has(name)) continue;
        seen.add(name);

        results.push({
          name,
          description: parseFrontmatterField(content, "description").slice(0, 150),
          path: path.join(skillsDir, entry.name),
          source: "plugin",
          plugin: pluginKey,
        });
      }
    }

    if (!hadPartialReadError) {
      pluginSkillsCache = { timestamp: now, mtime, results };
    }
    return results;
  } catch {
    return [];
  }
}

interface CopilotPluginSkillsCache {
  timestamp: number;
  snapshot: CopilotPluginSnapshotEntry[];
  results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }>;
}
let copilotPluginSkillsCache: CopilotPluginSkillsCache | null = null;

interface CopilotPluginSnapshotEntry {
  path: string;
  kind: "file" | "dir";
  mtime: number;
  size: number;
}

function readSnapshotEntry(filePath: string, kind: "file" | "dir"): CopilotPluginSnapshotEntry | null {
  try {
    const stat = fs.statSync(filePath);
    if (kind === "file" && !stat.isFile()) return null;
    if (kind === "dir" && !stat.isDirectory()) return null;
    return { path: filePath, kind, mtime: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

function isCopilotPluginSnapshotValid(snapshot: CopilotPluginSnapshotEntry[]): boolean {
  for (const entry of snapshot) {
    const current = readSnapshotEntry(entry.path, entry.kind);
    if (!current) return false;
    if (current.mtime !== entry.mtime) return false;
    if (entry.kind === "file" && current.size !== entry.size) return false;
  }
  return true;
}

function scanCopilotPluginSkills(): Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> {
  const root = path.join(os.homedir(), ".copilot", "installed-plugins");

  const rootSnapshot = readSnapshotEntry(root, "dir");
  if (!rootSnapshot) return [];

  const now = Date.now();
  if (
    copilotPluginSkillsCache !== null &&
    now - copilotPluginSkillsCache.timestamp < PLUGIN_SKILLS_CACHE_TTL_MS &&
    isCopilotPluginSnapshotValid(copilotPluginSkillsCache.snapshot)
  ) {
    return copilotPluginSkillsCache.results;
  }

  const snapshot: CopilotPluginSnapshotEntry[] = [rootSnapshot];
  const tracked = new Set<string>([rootSnapshot.path]);
  const track = (filePath: string, kind: "file" | "dir") => {
    if (tracked.has(filePath)) return;
    tracked.add(filePath);
    const entry = readSnapshotEntry(filePath, kind);
    if (entry) snapshot.push(entry);
  };

  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> = [];
  const seen = new Set<string>();
  let hadPartialReadError = false;

  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(root, scope.name);
    track(scopeDir, "dir");
    let plugins: fs.Dirent[];
    try {
      plugins = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      hadPartialReadError = true;
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = path.join(scopeDir, plugin.name);
      track(pluginDir, "dir");
      const skillsDir = path.join(scopeDir, plugin.name, "skills");
      const skillsDirEntry = readSnapshotEntry(skillsDir, "dir");
      if (!skillsDirEntry) continue;
      if (!tracked.has(skillsDirEntry.path)) {
        tracked.add(skillsDirEntry.path);
        snapshot.push(skillsDirEntry);
      }
      let skillEntries: fs.Dirent[];
      try {
        skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        hadPartialReadError = true;
        continue;
      }
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch (error) {
          if (!isMissingPathError(error)) {
            hadPartialReadError = true;
          }
          continue;
        }
        track(skillMd, "file");
        const name = parseFrontmatterField(content, "name") || entry.name;
        if (seen.has(name)) continue;
        seen.add(name);
        results.push({
          name,
          description: parseFrontmatterField(content, "description").slice(0, 150),
          path: path.join(skillsDir, entry.name),
          source: "plugin",
          plugin: `${scope.name}/${plugin.name}`,
        });
      }
    }
  }

  if (!hadPartialReadError) {
    copilotPluginSkillsCache = { timestamp: now, snapshot, results };
  }

  return results;
}

// ── Message queue ─────────────────────────────────────────────────────────────

interface QueuedTurn {
  prompt: string;
  agent?: string;
  oneshotSkills?: string[];
  skipPersistence?: boolean;
  messageId?: string;
}

// Per-session FIFO queues for turns submitted while a turn is already running
const sessionQueues = new Map<string, QueuedTurn[]>();
// Per-session paused queues — set when a queued turn fails, cleared on recovery
const pausedQueues = new Map<string, { failed: QueuedTurn; remaining: QueuedTurn[] }>();

async function executeAgentTurn(
  db: Database,
  sessionId: string,
  turn: QueuedTurn,
  win: BrowserWindow
): Promise<void> {
  const session = getSession(db, sessionId);
  const project = listProjects(db).find((p) => p.id === session.project_id);
  if (!project) throw new Error(`Project not found for session ${sessionId}`);

  const effectiveConfig = {
    ...project.config,
    provider: session.provider ?? project.config.provider,
    model: session.model ?? project.config.model,
  };
  const sessionSkills = session.skills ?? [];
  const oneshotSkills = turn.oneshotSkills ?? [];
  const allSkills = [...new Set([...sessionSkills, ...oneshotSkills])];
  const agent = turn.agent ?? session.agent ?? undefined;
  const skills = allSkills.length > 0 ? allSkills : undefined;

  let prompt = turn.prompt;
  if (session.github_issue_number != null && session.messages.length === 1) {
    const projectPath = session.workspace_path ?? project.path;
    try {
      const result = await getIssue({ projectPath, issueNumber: session.github_issue_number });
      if ("issue" in result) {
        const { issue } = result;
        const labelStr = issue.labels?.length ? issue.labels.join(", ") : "none";
        const bodyStr = issue.body ? `\n\n${issue.body}` : "";
        prompt = `GitHub Issue #${issue.number}: ${issue.title}\nLabels: ${labelStr}${bodyStr}\n\n---\n\n${turn.prompt}`;
      } else {
        console.warn(`[issue-context] Issue #${session.github_issue_number} context unavailable: ${result.error}`);
      }
    } catch (err) {
      console.warn(`[issue-context] Failed to fetch issue #${session.github_issue_number}:`, err);
    }
  }

  await runAgentTurn({
    db,
    sessionId,
    prompt,
    projectPath: session.workspace_path ?? project.path,
    projectConfig: effectiveConfig,
    webContents: win.webContents,
    agent,
    skills,
    skipPersistence: turn.skipPersistence,
  });
}

// Starts draining the next queued turn. Must be called only when activeTurns
// does NOT contain sessionId — this function re-adds it synchronously before
// any await so no concurrent AGENT_SEND can slip through.
function drainNextQueued(
  db: Database,
  sessionId: string,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  const queue = sessionQueues.get(sessionId);
  if (!queue || queue.length === 0) {
    sessionQueues.delete(sessionId);
    return;
  }

  const win = getMainWindow();
  if (!win) {
    // Window is unavailable (shutdown/reload) — clear the queue so subsequent
    // AGENT_SEND calls are not permanently wedged by sessionQueues.has().
    sessionQueues.delete(sessionId);
    return;
  }

  const next = queue.shift()!;
  if (queue.length === 0) sessionQueues.delete(sessionId);

  win.webContents.send(CH.SESSION_QUEUE_TURN_START, {
    session_id: sessionId,
    message_id: next.messageId,
  });

  // Re-claim activeTurns synchronously before any await to prevent races.
  activeTurns.add(sessionId);

  executeAgentTurn(db, sessionId, next, win)
    .then(() => {
      activeTurns.delete(sessionId);
      drainNextQueued(db, sessionId, activeTurns, getMainWindow);
    })
    .catch((err: unknown) => {
      activeTurns.delete(sessionId);
      console.error(`[queue] queued turn failed for session ${sessionId} (messageId=${next.messageId ?? "none"}):`, err);
      const remaining = [...(sessionQueues.get(sessionId) ?? [])];
      sessionQueues.delete(sessionId);
      const w = getMainWindow();
      if (w) {
        // Pause the queue and surface a recovery prompt.
        pausedQueues.set(sessionId, { failed: next, remaining });
        w.webContents.send(CH.SESSION_QUEUE_RECOVERY_REQUIRED, {
          session_id: sessionId,
          remaining_count: remaining.length,
          failed_message_id: next.messageId,
        });
      }
      // If no window: don't set pausedQueues — that would wedge future sends behind
      // a paused state the renderer can never recover from. Queued items are lost but
      // the session is unblocked. Badges clear on next renderer load (store resets).
    });
}

/** Called by DELETE_SESSION to purge all queue state for a deleted session. */
export function cleanupSessionQueueState(sessionId: string): void {
  sessionQueues.delete(sessionId);
  pausedQueues.delete(sessionId);
}

// ── Handler registration ──────────────────────────────────────────────────────

export function registerAgentHandlers(
  db: Database,
  activeTurns: Set<string>,
  getMainWindow: () => BrowserWindow | null
): void {
  handle(CH.AGENT_SEND, async (_event, args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[]; skipPersistence?: boolean; messageId?: string }) => {
    const win = getMainWindow();
    if (!win) throw new Error("No window available");

    const turn: QueuedTurn = {
      prompt: args.prompt,
      agent: args.agent,
      oneshotSkills: args.oneshotSkills,
      skipPersistence: args.skipPersistence,
      messageId: args.messageId,
    };

    const isBusy = activeTurns.has(args.sessionId)
      || sessionQueues.has(args.sessionId)
      || pausedQueues.has(args.sessionId);
    if (isBusy) {
      // Only real chat messages (already saved to SQLite, not skipPersistence) are
      // safe to queue. Other callers (e.g. PR description generator) expect the IPC
      // call to represent the full lifetime of the turn and don't handle { queued: true }.
      if (!args.messageId || args.skipPersistence) {
        throw new Error(`Session ${args.sessionId} is busy — cannot queue non-chat turns`);
      }
      // Enqueue and return immediately.
      const existing = sessionQueues.get(args.sessionId) ?? [];
      sessionQueues.set(args.sessionId, [...existing, turn]);
      return { queued: true };
    }

    activeTurns.add(args.sessionId);
    let succeeded = false;
    try {
      await executeAgentTurn(db, args.sessionId, turn, win);
      succeeded = true;
    } finally {
      activeTurns.delete(args.sessionId);
      if (succeeded) {
        // Drain queued turns (re-adds to activeTurns synchronously if queue is non-empty).
        drainNextQueued(db, args.sessionId, activeTurns, getMainWindow);
      } else {
        // Direct turn failed — if messages were queued behind it, surface a recovery
        // prompt instead of silently dropping them (which leaves permanent "Queued" badges).
        const queued = [...(sessionQueues.get(args.sessionId) ?? [])];
        sessionQueues.delete(args.sessionId);
        if (queued.length > 0) {
          const w = getMainWindow();
          if (w) {
            pausedQueues.set(args.sessionId, { failed: turn, remaining: queued });
            w.webContents.send(CH.SESSION_QUEUE_RECOVERY_REQUIRED, {
              session_id: args.sessionId,
              remaining_count: queued.length,
              failed_message_id: turn.messageId,
            });
          }
          // If no window: don't set pausedQueues — that would wedge future sends
          // behind a paused state the renderer can never recover from.
        }
      }
    }

    return { queued: false };
  });

  handle(CH.AGENT_QUEUE_RECOVERY, (_event, args: { sessionId: string; action: "retry" | "skip" | "clear" }) => {
    const paused = pausedQueues.get(args.sessionId);
    if (!paused) return;

    if (args.action === "clear") {
      pausedQueues.delete(args.sessionId);
      sessionQueues.delete(args.sessionId);
      return;
    }

    const recoveryTurns: QueuedTurn[] =
      args.action === "retry"
        ? [paused.failed, ...paused.remaining]
        : paused.remaining;

    // Preserve any new turns enqueued while the queue was paused.
    const newlyQueued = sessionQueues.get(args.sessionId) ?? [];
    const mergedQueue = [...recoveryTurns, ...newlyQueued];

    pausedQueues.delete(args.sessionId);

    if (mergedQueue.length === 0) return;

    sessionQueues.set(args.sessionId, mergedQueue);

    if (!activeTurns.has(args.sessionId)) {
      drainNextQueued(db, args.sessionId, activeTurns, getMainWindow);
    }
    // If a turn is somehow already running, drainNextQueued fires when it finishes.
  });

  handle(CH.GET_COPILOT_MODELS, () => getProvider("copilot").listModels?.());
  handle(CH.GET_OLLAMA_MODELS, () => getProvider("ollama").listModels?.());
  handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getProvider("anthropic").listAgents?.(projectPath);
  });
  handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return getProvider("copilot").listAgents?.(projectPath);
  });

  handle(CH.LIST_SKILLS, (_event, args: string | { projectPath: string; provider?: string }) => {
    const projectPath = typeof args === "string" ? args : args.projectPath;
    const provider = typeof args === "string" ? undefined : args.provider;

    const projectSkillsDir = path.join(projectPath, ".agents", "skills");
    const projectSkills = scanSkillsDir(projectSkillsDir, "project");

    const isCopilot = provider === "copilot";
    const globalSkillsDir = isCopilot
      ? path.join(os.homedir(), ".agents", "skills")
      : path.join(os.homedir(), ".claude", "skills");
    const globalSkills = scanSkillsDir(globalSkillsDir, "global");
    const pluginSkills = isCopilot ? scanCopilotPluginSkills() : scanPluginSkills();

    const projectNames = new Set(projectSkills.map((s) => s.name));
    const globalFiltered = globalSkills.filter((s) => !projectNames.has(s.name));
    const usedNames = new Set([...projectNames, ...globalFiltered.map((s) => s.name)]);
    const pluginFiltered = pluginSkills.filter((s) => !usedNames.has(s.name));

    return [...projectSkills, ...globalFiltered, ...pluginFiltered];
  });

  handle(
    CH.APPROVE_TOOL_CALL,
    (_event, args: {
      sessionId: string;
      approvalId: string;
      approved: boolean;
      scope?: "once" | "session" | "project";
      projectId?: string;
    }) => {
      if (args.approved && args.scope && args.scope !== "once") {
        const data = getPendingApprovalData(args.approvalId);
        if (data) {
          if (args.scope === "session") {
            addToSessionAllowlist(data.sessionId, data.toolName, data.args);
          } else if (args.scope === "project" && args.projectId) {
            const config = getProjectConfig(db, args.projectId);
            const fp = computeFingerprint(data.toolName, data.args);
            const pattern = data.toolName === "execute_bash"
              ? fp.replace("execute_bash:", "") || undefined
              : undefined;
            const existing = config.allowed_tools ?? [];
            const alreadyExists = existing.some(
              (t) => t.tool_name === data.toolName && t.command_pattern === pattern
            );
            if (!alreadyExists) {
              config.allowed_tools = [...existing, { tool_name: data.toolName, command_pattern: pattern }];
              saveProjectConfig(db, args.projectId, config);
            }
          }
        }
      }
      resolveApproval(args.approvalId, args.approved);
    }
  );

  handle(
    CH.ANSWER_QUESTION,
    (_event, args: { questionId: string; answer: string }) => {
      resolveQuestion(args.questionId, args.answer);
    }
  );

  handle(
    CH.WRITE_AGENT_FILE,
    (_event, args: { filePath: string; content: string }) => {
      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      fs.writeFileSync(args.filePath, args.content, "utf8");
    }
  );
  handle(CH.DELETE_AGENT_FILE, (_event, filePath: string) => {
    fs.unlinkSync(filePath);
  });
  handle(
    CH.CREATE_AGENT,
    (
      _event,
      args: {
        provider: string;
        name: string;
        projectPath: string;
        scope: "global" | "project";
        content: string;
      }
    ) => {
      let filePath: string;
      if (args.provider === "anthropic") {
        filePath = path.join(os.homedir(), ".claude", "agents", `${args.name}.md`);
      } else if (args.scope === "project") {
        filePath = path.join(args.projectPath, ".agents", "copilot-agents", `${args.name}.md`);
      } else {
        filePath = path.join(os.homedir(), ".github-copilot", "agents", `${args.name}.md`);
      }
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, "utf8");
      return { filePath };
    }
  );
  handle(
    CH.WRITE_SKILL_FILE,
    (_event, args: { skillPath: string; content: string }) => {
      fs.mkdirSync(args.skillPath, { recursive: true });
      fs.writeFileSync(path.join(args.skillPath, "SKILL.md"), args.content, "utf8");
    }
  );
  handle(CH.DELETE_SKILL_DIR, (_event, skillPath: string) => {
    fs.rmSync(skillPath, { recursive: true, force: true });
  });
  handle(
    CH.CREATE_SKILL,
    (
      _event,
      args: {
        name: string;
        projectPath: string;
        scope: "global" | "project";
        content: string;
      }
    ) => {
      const skillPath =
        args.scope === "project"
          ? path.join(args.projectPath, ".agents", "skills", args.name)
          : path.join(os.homedir(), ".claude", "skills", args.name);
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, "SKILL.md"), args.content, "utf8");
      return { skillPath };
    }
  );
}
