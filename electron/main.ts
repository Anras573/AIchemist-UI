import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as childProcess from "child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import * as CH from "./ipc-channels";
import { loadEnv, getApiKey, getAnthropicConfig, checkApiKeys, resolveClaudePath } from "./config";
import { openDb } from "./db";
import { addProject, listProjects, removeProject, getProjectConfig, saveProjectConfig } from "./projects";
import { createSession, listSessions, getSession, deleteSession, saveMessage, updateSessionTitle, updateSessionModel, updateSessionAgent, updateSessionSkills, setDisabledMcpServers, getDisabledMcpServers, recoverStaleSessionStatuses } from "./sessions";
import { openFolderDialog } from "./dialog";
import { readSettings, writeSettings } from "./settings";
import type { SettingsMap } from "./settings";
import { resolveApproval, resolvePermissionChoice, getPendingApprovalData, addToSessionAllowlist, computeFingerprint, cancelSessionApprovals } from "./agent/approval";
import { resolveQuestion, cancelSessionQuestions } from "./agent/question";
import { runAgentTurn, getProvider } from "./agent/runner";
import { cleanupCopilotSession } from "./agent/copilot";
import type { TraceSpan } from "../src/types/index";
import {
  findTranscriptFile,
  parseTranscript,
  transcriptToSpans,
  watchTranscript,
  resolveProjectDir,
  type TranscriptWatcher,
} from "./claude-transcript";
import {
  findCopilotEventsFile,
  parseCopilotEvents,
  copilotEventsToSpans,
  watchCopilotTranscript,
  type CopilotTranscriptWatcher,
} from "./copilot-transcript";
import type { ProjectConfig } from "../src/types/index";
import { parseMcpListOutput, readCopilotMcpServers, readAichemistMcpServers, mergeMcpServers } from "./mcp-utils";
import { loadManagedMcpServers } from "./agent/mcp-managed";
import { probeManagedServers } from "./agent/mcp-probe";
import {
  readMcpServers as readMcpServersConfig,
  writeMcpServers as writeMcpServersConfig,
  deleteMcpServer as deleteMcpServerConfig,
  type McpScope,
  type McpServersMap,
} from "./mcp-config";
import type { McpServerInfo } from "../src/types/index";

// ── Prevent multiple instances ───────────────────────────────────────────────
if (require("electron-squirrel-startup")) app.quit();

// ── Startup: load env + open DB ──────────────────────────────────────────────
loadEnv();
const db = openDb();

// ── Dev/prod renderer URL (electron-vite convention) ─────────────────────────
// In dev, electron-vite injects ELECTRON_RENDERER_URL into the environment.
// In production, load the built index.html from dist/renderer.

let mainWin: BrowserWindow | null = null;

// Active PTY processes keyed by a UUID assigned at creation time.
const terminals = new Map<string, IPty>();

// Sessions that currently have an agent turn in progress.
// Prevents concurrent turns on the same session (e.g. rapid double-send).
const activeTurns = new Set<string>();

export function getMainWindow(): BrowserWindow | null {
  return mainWin;
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    win.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWin = win;
  win.on("closed", () => { mainWin = null; });
  return win;
}

// ── IPC handler wrapper ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (event: Electron.IpcMainInvokeEvent, ...args: any[]) => any;

/**
 * Registers an ipcMain handler that catches all errors, logs them to the
 * console with the channel name, and re-throws a clean Error so the renderer's
 * `invoke()` promise always rejects with a readable message rather than
 * hanging or crashing silently.
 */
function handle(channel: string, handler: Handler): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await handler(event, ...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[IPC] "${channel}" failed:`, err);
      throw new Error(message);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extracts a value from YAML frontmatter in a markdown file. */
function parseFrontmatterField(content: string, field: string): string {
  const singleLine = content.match(new RegExp(`^${field}:\\s*["']?(.+?)["']?\\s*$`, "m"));
  const value = singleLine?.[1]?.trim() ?? "";

  // YAML block scalar indicators (|, >, |-, >-, etc.) — read the indented block instead
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

/** Scans a skills directory and returns an array of user-created skill entries. */
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
        // Try SKILL.md frontmatter first, fall back to README.md first paragraph
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

/**
 * Scans Claude Code's installed plugin cache for skills (plugins that ship
 * a `skills/<name>/SKILL.md` layout). Returns read-only skill entries.
 */
function scanPluginSkills(): Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> {
  const pluginsFile = path.join(os.homedir(), ".claude", "plugins", "installed_plugins.json");
  try {
    const data = JSON.parse(fs.readFileSync(pluginsFile, "utf-8")) as {
      plugins: Record<string, Array<{ installPath: string; lastUpdated?: string }>>;
    };

    const results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> = [];
    const seen = new Set<string>();

    for (const [pluginKey, entries] of Object.entries(data.plugins)) {
      // Pick the most recently updated install of this plugin
      const sorted = [...entries].sort((a, b) =>
        (b.lastUpdated ?? "").localeCompare(a.lastUpdated ?? "")
      );
      const installPath = sorted[0]?.installPath;
      if (!installPath) continue;

      const skillsDir = path.join(installPath, "skills");
      let dirEntries: fs.Dirent[];
      try {
        dirEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of dirEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch {
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

    return results;
  } catch {
    return [];
  }
}

/**
 * Scans Copilot CLI's installed plugins for skills under
 * `~/.copilot/installed-plugins/<scope>/<plugin>/skills/<name>/SKILL.md`.
 */
function scanCopilotPluginSkills(): Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> {
  const root = path.join(os.homedir(), ".copilot", "installed-plugins");
  let scopes: fs.Dirent[];
  try {
    scopes = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: Array<{ name: string; description: string; path: string; source: "plugin"; plugin: string }> = [];
  const seen = new Set<string>();

  for (const scope of scopes) {
    if (!scope.isDirectory()) continue;
    const scopeDir = path.join(root, scope.name);
    let plugins: fs.Dirent[];
    try {
      plugins = fs.readdirSync(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (!plugin.isDirectory()) continue;
      const skillsDir = path.join(scopeDir, plugin.name, "skills");
      let skillEntries: fs.Dirent[];
      try {
        skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of skillEntries) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(skillsDir, entry.name, "SKILL.md");
        let content: string;
        try {
          content = fs.readFileSync(skillMd, "utf-8");
        } catch {
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
          plugin: `${scope.name}/${plugin.name}`,
        });
      }
    }
  }

  return results;
}

function registerHandlers(): void {  // ── Terminal ──────────────────────────────────────────────────────────────────
  handle(CH.TERMINAL_CREATE, (_event, projectPath: string) => {
    const id = crypto.randomUUID();
    const isWindows = process.platform === "win32";
    const shell = isWindows
      ? (process.env.COMSPEC ?? "cmd.exe")
      : (process.env.SHELL ?? "/bin/bash");
    const env = isWindows
      ? ({ ...process.env } as Record<string, string>)
      : (() => {
          const extraPaths = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
          return { ...process.env, PATH: `${extraPaths}:${process.env.PATH ?? ""}` } as Record<string, string>;
        })();

    const term = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: projectPath,
      env,
    });

    terminals.set(id, term);

    term.onData((data) => {
      getMainWindow()?.webContents.send(CH.TERMINAL_OUTPUT, { id, data });
    });

    term.onExit(() => {
      terminals.delete(id);
      getMainWindow()?.webContents.send(CH.TERMINAL_OUTPUT, { id, data: "\r\n[Process exited]\r\n" });
    });

    return id;
  });

  handle(CH.TERMINAL_INPUT, (_event, id: string, data: string) => {
    terminals.get(id)?.write(data);
  });

  handle(CH.TERMINAL_RESIZE, (_event, id: string, cols: number, rows: number) => {
    terminals.get(id)?.resize(cols, rows);
  });

  handle(CH.TERMINAL_CLOSE, (_event, id: string) => {
    const term = terminals.get(id);
    if (term) {
      try { term.kill(); } catch { /* already exited */ }
      terminals.delete(id);
    }
  });

  // ── Settings ─────────────────────────────────────────────────────────────────
  handle(CH.SETTINGS_READ, () => readSettings());
  handle(CH.SETTINGS_WRITE, (_event, updates: Partial<SettingsMap>) =>
    writeSettings(updates)
  );

  // ── Traces ───────────────────────────────────────────────────────────────────

  /**
   * Per-session transcript watchers. The renderer binds one when a session
   * is opened and unbinds on cleanup / session switch. We dispatch to the
   * Claude or Copilot transcript reader based on which SDK id the session
   * has persisted.
   */
  const claudeWatchers = new Map<string, TranscriptWatcher>();
  const copilotWatchers = new Map<string, CopilotTranscriptWatcher>();

  type TraceSource =
    | { kind: "claude"; projectPath: string; sdkSessionId: string }
    | { kind: "copilot"; copilotSessionId: string }
    | null;

  function resolveTraceSource(sessionId: string): TraceSource {
    const row = db
      .prepare(
        `SELECT s.sdk_session_id AS sdkSessionId,
                s.copilot_session_id AS copilotSessionId,
                p.path AS projectPath
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`
      )
      .get(sessionId) as
      | { sdkSessionId: string | null; copilotSessionId: string | null; projectPath: string }
      | undefined;
    if (!row) return null;
    if (row.sdkSessionId) {
      return { kind: "claude", projectPath: row.projectPath, sdkSessionId: row.sdkSessionId };
    }
    if (row.copilotSessionId) {
      return { kind: "copilot", copilotSessionId: row.copilotSessionId };
    }
    return null;
  }

  async function loadTranscriptSpans(sessionId: string): Promise<TraceSpan[]> {
    const src = resolveTraceSource(sessionId);
    if (!src) return [];
    if (src.kind === "claude") {
      const file = await findTranscriptFile(src.projectPath, src.sdkSessionId);
      if (!file) return [];
      const entries = await parseTranscript(file);
      return transcriptToSpans(entries, { sessionId, sdkSessionId: src.sdkSessionId });
    }
    const file = await findCopilotEventsFile(src.copilotSessionId);
    if (!file) return [];
    const events = await parseCopilotEvents(file);
    return copilotEventsToSpans(events, { sessionId, copilotSessionId: src.copilotSessionId });
  }

  handle(CH.GET_TRACES, async (_event, sessionId?: string) => {
    if (!sessionId) return [];
    try {
      return await loadTranscriptSpans(sessionId);
    } catch {
      return [];
    }
  });

  // ── Memory ──────────────────────────────────────────────────────────────────
  // Lists Claude memory files for a project (provider-agnostic dir lookup).
  // Memory files live at ~/.claude/projects/<sanitized-cwd>/memory/*.md
  handle(CH.LIST_MEMORY, async (_event, projectPath: string) => {
    if (!projectPath) return { files: [] as Array<{ name: string; path: string }> };
    try {
      const projectDir = await resolveProjectDir(projectPath);
      if (!projectDir) return { files: [] };
      const memDir = path.join(projectDir, "memory");
      let names: string[];
      try {
        names = await fs.promises.readdir(memDir);
      } catch {
        return { files: [] };
      }
      const files = names
        .filter((n) => n.toLowerCase().endsWith(".md"))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .map((name) => ({ name, path: path.join(memDir, name) }));
      return { files };
    } catch {
      return { files: [] };
    }
  });

  handle(CH.TRACE_BIND_TRANSCRIPT, (_event, sessionId: string) => {
    if (!sessionId) return { ok: false };
    if (claudeWatchers.has(sessionId) || copilotWatchers.has(sessionId)) return { ok: true };

    const src = resolveTraceSource(sessionId);
    if (!src) return { ok: false, reason: "no-sdk-session-id" };

    const onUpdate = (spans: TraceSpan[]) => {
      const win = getMainWindow();
      if (!win) return;
      for (const span of spans) win.webContents.send(CH.SESSION_TRACE, span);
    };

    if (src.kind === "claude") {
      const watcher = watchTranscript(src.projectPath, src.sdkSessionId, sessionId, { onUpdate });
      claudeWatchers.set(sessionId, watcher);
    } else {
      const watcher = watchCopilotTranscript(src.copilotSessionId, sessionId, { onUpdate });
      copilotWatchers.set(sessionId, watcher);
    }
    return { ok: true };
  });

  handle(CH.TRACE_UNBIND_TRANSCRIPT, (_event, sessionId: string) => {
    const a = claudeWatchers.get(sessionId);
    if (a) { a.close(); claudeWatchers.delete(sessionId); }
    const b = copilotWatchers.get(sessionId);
    if (b) { b.close(); copilotWatchers.delete(sessionId); }
    return { ok: true };
  });

  handle(CH.GET_GIT_BRANCH, (_event, projectPath: string) => {
    const extraPaths = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
    const env = { ...process.env, PATH: `${extraPaths}:${process.env.PATH ?? ""}` };
    try {
      return childProcess
        .execSync("git branch --show-current", { cwd: projectPath, encoding: "utf8", timeout: 5_000, env })
        .trim() || null;
    } catch {
      return null;
    }
  });

  handle(CH.GET_GIT_DIFF, (_event, projectPath: string) => {
    // Add common git locations to PATH — Electron on macOS doesn't inherit the shell PATH.
    const extraPaths = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
    const env = { ...process.env, PATH: `${extraPaths}:${process.env.PATH ?? ""}` };

    const run = (cmd: string) =>
      childProcess.execSync(cmd, { cwd: projectPath, encoding: "utf8", timeout: 10_000, env });

    try {
      // `git diff HEAD --no-color` shows all tracked-file changes (staged + unstaged) vs last commit.
      // Fall back to `git diff --no-color --cached` when there is no HEAD yet (brand-new repo).
      let diff = "";
      try {
        diff = run("git diff HEAD --no-color");
      } catch (headErr) {
        const e = headErr as { stderr?: string };
        const isNoHead = e.stderr?.includes("ambiguous argument") || e.stderr?.includes("unknown revision");
        if (isNoHead) {
          diff = run("git diff --no-color --cached");
        } else {
          throw headErr;
        }
      }

      // Also append a list of untracked files — `git diff HEAD` never shows them.
      const untracked = run("git ls-files --others --exclude-standard").trim();
      if (untracked) {
        const header = "=== Untracked files ===\n";
        diff = diff ? `${diff}\n${header}${untracked}` : `${header}${untracked}`;
      }

      return diff;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      if (e.code === "ENOENT") return { error: "git not found — ensure git is installed" };
      if (e.stdout) return e.stdout;
      return { error: e.stderr?.trim() ?? String(err) };
    }
  });

  // ── Config ──────────────────────────────────────────────────────────────────
  handle(CH.GET_API_KEY, (_event, provider: string) =>
    getApiKey(provider)
  );
  handle(CH.GET_ANTHROPIC_CONFIG, () => getAnthropicConfig());

  // ── Projects ─────────────────────────────────────────────────────────────────
  handle(CH.ADD_PROJECT, (_event, projectPath: string) => addProject(db, projectPath));
  handle(CH.LIST_PROJECTS, () => listProjects(db));
  handle(CH.REMOVE_PROJECT, (_event, id: string) =>
    removeProject(db, id)
  );
  handle(CH.GET_PROJECT_CONFIG, (_event, id: string) =>
    getProjectConfig(db, id)
  );
  handle(
    CH.SAVE_PROJECT_CONFIG,
    (_event, id: string, config: ProjectConfig) =>
      saveProjectConfig(db, id, config)
  );

  // ── Sessions ─────────────────────────────────────────────────────────────────
  handle(CH.CREATE_SESSION, (_event, payload: string | { projectId: string; providerOverride?: string }) => {
    // Backward-compat: older callers pass projectId as a string; newer ones
    // pass { projectId, providerOverride } to explicitly lock the session's
    // provider at creation time (e.g. from the split-button new-session menu).
    const projectId = typeof payload === "string" ? payload : payload.projectId;
    const providerOverride = typeof payload === "string" ? undefined : payload.providerOverride;

    const project = listProjects(db).find((p) => p.id === projectId);
    const provider = providerOverride ?? project?.config.provider ?? null;

    // When the user explicitly picks a provider different from the project
    // default, we can't reuse project.config.model (it belongs to the other
    // SDK). Anthropic has a known default list; Copilot models are dynamic
    // so we leave model null and let the runner fall back to the SDK default.
    let model: string | null;
    if (providerOverride && providerOverride !== project?.config.provider) {
      model = provider === "anthropic" ? "claude-sonnet-4-6" : null;
    } else {
      model = project?.config.model ?? null;
    }

    return createSession(db, projectId, provider, model);
  });
  handle(CH.LIST_SESSIONS, (_event, projectId: string) =>
    listSessions(db, projectId)
  );
  handle(CH.GET_SESSION, (_event, sessionId: string) =>
    getSession(db, sessionId)
  );
  handle(CH.DELETE_SESSION, (_event, sessionId: string) => {
    cancelSessionApprovals(sessionId);
    cancelSessionQuestions(sessionId);
    cleanupCopilotSession(sessionId);
    activeTurns.delete(sessionId);
    return deleteSession(db, sessionId);
  });
  handle(
    CH.SAVE_MESSAGE,
    (_event, args: { sessionId: string; role: string; content: string }) =>
      saveMessage(db, args)
  );
  handle(
    CH.UPDATE_SESSION_TITLE,
    (_event, sessionId: string, title: string) =>
      updateSessionTitle(db, sessionId, title)
  );
  handle(
    CH.UPDATE_SESSION_MODEL,
    (_event, sessionId: string, provider: string, model: string) =>
      updateSessionModel(db, sessionId, provider, model)
  );
  handle(
    CH.UPDATE_SESSION_AGENT,
    (_event, sessionId: string, agent: string | null) =>
      updateSessionAgent(db, sessionId, agent)
  );
  handle(
    CH.UPDATE_SESSION_SKILLS,
    (_event, sessionId: string, skills: string[]) =>
      updateSessionSkills(db, sessionId, skills)
  );
  handle(
    CH.UPDATE_SESSION_DISABLED_MCP,
    (_event, sessionId: string, names: string[]) => {
      setDisabledMcpServers(db, sessionId, names);
      return getDisabledMcpServers(db, sessionId);
    }
  );

  // ── File system ───────────────────────────────────────────────────────────────

  // Directories that are never useful to browse in the file tree.
  const IGNORED_DIR_NAMES = new Set([
    "node_modules", ".git", ".hg", ".svn",
    "dist", "build", "out", ".next", ".nuxt", ".turbo",
    "__pycache__", ".cache", ".parcel-cache", ".vite",
    "coverage", ".nyc_output",
  ]);
  const MAX_DIR_ENTRIES = 500;

  handle(CH.LIST_DIRECTORY, (_event, dirPath: string) => {
    try {
      const dirents = fs.readdirSync(dirPath, { withFileTypes: true });
      const filtered = dirents.filter((d) => !(d.isDirectory() && IGNORED_DIR_NAMES.has(d.name)));
      const truncated = filtered.length > MAX_DIR_ENTRIES;
      const visible = truncated ? filtered.slice(0, MAX_DIR_ENTRIES) : filtered;
      const entries = visible.map((dirent) => {
        const entryPath = path.join(dirPath, dirent.name);
        let size_bytes = 0;
        if (!dirent.isDirectory()) {
          try {
            size_bytes = fs.statSync(entryPath).size;
          } catch {
            size_bytes = 0;
          }
        }
        return {
          name: dirent.name,
          path: entryPath,
          is_dir: dirent.isDirectory(),
          size_bytes,
        };
      });
      return { entries, truncated };
    } catch {
      return { entries: [], truncated: false };
    }
  });

  handle(CH.READ_FILE, (_event, filePath: string) => {
    const MAX_BYTES = 512 * 1024; // 512 KB
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_BYTES) {
        return { error: `File too large (${Math.round(stat.size / 1024)} KB). Only files under 512 KB can be previewed.` };
      }
      const buf = fs.readFileSync(filePath);
      // Binary detection: null byte in first 8 KB
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { error: "Binary file — cannot display as text." };
      }
      return { content: buf.toString("utf8") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Dialog ────────────────────────────────────────────────────────────────────
  handle(CH.OPEN_FOLDER_DIALOG, () => openFolderDialog());

  // ── Agent ─────────────────────────────────────────────────────────────────────
  handle(CH.AGENT_SEND, async (_event, args: { sessionId: string; prompt: string; agent?: string; oneshotSkills?: string[] }) => {
    const win = getMainWindow();
    if (!win) throw new Error("No window available");

    if (activeTurns.has(args.sessionId)) {
      throw new Error("A turn is already in progress for this session. Please wait for it to complete.");
    }

    // Snapshot session + project config synchronously before any async gap.
    const session = getSession(db, args.sessionId);
    const project = listProjects(db).find((p) => p.id === session.project_id);
    if (!project) throw new Error(`Project not found for session ${args.sessionId}`);
    const effectiveConfig = {
      ...project.config,
      provider: session.provider ?? project.config.provider,
      model: session.model ?? project.config.model,
    };
    const agent = args.agent ?? session.agent ?? undefined;
    // Merge session-level skills with any one-shot skills for this turn only
    const sessionSkills = session.skills ?? [];
    const oneshotSkills = args.oneshotSkills ?? [];
    const allSkills = [...new Set([...sessionSkills, ...oneshotSkills])];
    const skills = allSkills.length > 0 ? allSkills : undefined;

    activeTurns.add(args.sessionId);
    try {
      await runAgentTurn({
        db,
        sessionId: args.sessionId,
        prompt: args.prompt,
        projectPath: project.path,
        projectConfig: effectiveConfig,
        webContents: win.webContents,
        agent,
        skills,
      });
    } finally {
      activeTurns.delete(args.sessionId);
    }
  });
  handle(CH.GET_COPILOT_MODELS, () => getProvider("copilot").listModels?.());
  handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getProvider("anthropic").listAgents?.(projectPath);
  });
  handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return getProvider("copilot").listAgents?.(projectPath);
  });
  handle(CH.LIST_SKILLS, (_event, args: string | { projectPath: string; provider?: string }) => {
    // Back-compat: bare string is the legacy signature (treated as Claude).
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

    // Project-local skills take highest priority, then global, then plugins.
    // Later tiers skip any name already claimed by a higher-priority tier.
    const projectNames = new Set(projectSkills.map((s) => s.name));
    const globalFiltered = globalSkills.filter((s) => !projectNames.has(s.name));
    const usedNames = new Set([...projectNames, ...globalFiltered.map((s) => s.name)]);
    const pluginFiltered = pluginSkills.filter((s) => !usedNames.has(s.name));

    return [...projectSkills, ...globalFiltered, ...pluginFiltered];
  });
  handle(CH.LIST_MCP_SERVERS, async () => {
    const claudePath = resolveClaudePath() ?? "claude";

    // Run `claude mcp list` async to avoid blocking the main process.
    const claudeServers = await new Promise<McpServerInfo[]>((resolve) => {
      childProcess.execFile(
        claudePath,
        ["mcp", "list"],
        { encoding: "utf-8", timeout: 15_000 },
        (_err, stdout) => resolve(parseMcpListOutput(stdout ?? "")),
      );
    });

    const copilotServers = readCopilotMcpServers();
    let aichemistServers = readAichemistMcpServers();

    // Overlay live probe results onto AIchemist rows. Cached (30s TTL) so
    // we don't re-spawn children on every panel mount.
    if (aichemistServers.length > 0) {
      try {
        const probeResults = await probeManagedServers(loadManagedMcpServers());
        aichemistServers = aichemistServers.map((s) => {
          const r = probeResults.get(s.name);
          if (!r) return s;
          return {
            ...s,
            connected: r.connected,
            tools: r.tools,
            error: r.error,
            status: r.connected ? "Connected" : (r.error ?? "Failed to connect"),
          };
        });
      } catch (err) {
        console.error("[mcp-probe] LIST_MCP_SERVERS probe failed", err);
        // Fall through with un-probed entries so the panel still renders.
      }
    }

    return mergeMcpServers(claudeServers, copilotServers, aichemistServers);
  });
  handle(CH.MCP_PROBE_MANAGED, async () => {
    // Force a fresh probe (bypasses the 30s cache). Returns the fully merged
    // server list — same shape as LIST_MCP_SERVERS — so the renderer can drop
    // it straight into state.
    const claudePath = resolveClaudePath() ?? "claude";
    const claudeServers = await new Promise<McpServerInfo[]>((resolve) => {
      childProcess.execFile(
        claudePath,
        ["mcp", "list"],
        { encoding: "utf-8", timeout: 15_000 },
        (_err, stdout) => resolve(parseMcpListOutput(stdout ?? "")),
      );
    });
    const copilotServers = readCopilotMcpServers();
    let aichemistServers = readAichemistMcpServers();
    if (aichemistServers.length > 0) {
      try {
        const probeResults = await probeManagedServers(loadManagedMcpServers(), { force: true });
        aichemistServers = aichemistServers.map((s) => {
          const r = probeResults.get(s.name);
          if (!r) return s;
          return {
            ...s,
            connected: r.connected,
            tools: r.tools,
            error: r.error,
            status: r.connected ? "Connected" : (r.error ?? "Failed to connect"),
          };
        });
      } catch (err) {
        console.error("[mcp-probe] MCP_PROBE_MANAGED probe failed", err);
      }
    }
    return mergeMcpServers(claudeServers, copilotServers, aichemistServers);
  });
  handle(CH.MCP_READ_CONFIG, (_event, args: { scope: McpScope; projectPath?: string }) => {
    return readMcpServersConfig(args.scope, args.projectPath);
  });
  handle(
    CH.MCP_WRITE_CONFIG,
    (_event, args: { scope: McpScope; servers: McpServersMap; projectPath?: string }) => {
      writeMcpServersConfig(args.scope, args.servers, args.projectPath);
    },
  );
  handle(
    CH.MCP_DELETE_SERVER,
    (_event, args: { scope: McpScope; name: string; projectPath?: string }) => {
      deleteMcpServerConfig(args.scope, args.name, args.projectPath);
    },
  );
  handle(
    CH.APPROVE_TOOL_CALL,
    (_event, args: {
      sessionId: string;
      approvalId: string;
      approved: boolean;
      scope?: "once" | "session" | "project";
      projectId?: string;
      /** ACP option id when resolving an option-based (choice) approval. null = cancelled. */
      optionId?: string | null;
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
      // ACP option-based path (UI passes optionId, possibly null for cancel).
      if (args.optionId !== undefined) {
        resolvePermissionChoice(args.approvalId, args.optionId);
      } else {
        resolveApproval(args.approvalId, args.approved);
      }
    }
  );

  handle(
    CH.ANSWER_QUESTION,
    (_event, args: { questionId: string; answer: string }) => {
      resolveQuestion(args.questionId, args.answer);
    }
  );

  // ── Agent / Skill file management ──────────────────────────────────────────
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

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  const stale = recoverStaleSessionStatuses(db);
  if (stale > 0) {
    console.log(`[startup] Marked ${stale} stale session(s) as "error" (were "running" at last exit)`);
  }

  registerHandlers();
  const win = createWindow();

  // Warn if no API keys are configured — both providers missing means
  // the user won't be able to run any agent turns.
  const missingKeys = checkApiKeys();
  if (missingKeys.length === 2) {
    // Both Anthropic and Copilot keys are absent — emit warning once window loads
    win.webContents.once("did-finish-load", () => {
      win.webContents.send(CH.CONFIG_WARNING, {
        message: `No API keys configured. Add ANTHROPIC_API_KEY or GITHUB_TOKEN to ~/.aichemist/.env to use the agent.`,
        missing: missingKeys,
      });
    });
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  // Kill all active terminal PTY processes.
  for (const term of terminals.values()) {
    try { term.kill(); } catch { /* already exited */ }
  }
  terminals.clear();

  // Gracefully shut down all providers that implement stop()
  for (const name of ["copilot", "anthropic"]) {
    try {
      void getProvider(name).stop?.();
    } catch {
      // Provider may not be registered; ignore
    }
  }
});
