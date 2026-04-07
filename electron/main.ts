import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as childProcess from "child_process";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import * as CH from "./ipc-channels";
import { loadEnv, getApiKey, getAnthropicConfig } from "./config";
import { openDb } from "./db";
import { addProject, listProjects, removeProject, getProjectConfig, saveProjectConfig } from "./projects";
import { createSession, listSessions, getSession, deleteSession, saveMessage, updateSessionTitle, updateSessionModel, updateSessionAgent, updateSessionSkills } from "./sessions";
import { openFolderDialog } from "./dialog";
import { readSettings, writeSettings } from "./settings";
import type { SettingsMap } from "./settings";
import { resolveApproval, getPendingApprovalData, addToSessionAllowlist, computeFingerprint } from "./agent/approval";
import { resolveQuestion } from "./agent/question";
import { runAgentTurn, getProvider } from "./agent/runner";
import { getSpans } from "./tracer";
import type { ProjectConfig } from "../src/types/index";

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

/** Scans a skills directory and returns an array of skill entries. */
function scanSkillsDir(
  dir: string
): Array<{ name: string; description: string; path: string }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((d) => {
        const skillPath = path.join(dir, d.name);
        let description = "";
        try {
          const content = fs.readFileSync(
            path.join(skillPath, "README.md"),
            "utf8"
          );
          // First non-empty, non-heading line becomes the description
          for (const line of content.split("\n")) {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
              description = trimmed.slice(0, 150);
              break;
            }
          }
        } catch {
          // no README — description stays empty
        }
        return { name: d.name, description, path: skillPath };
      });
  } catch {
    return [];
  }
}

function registerHandlers(): void {  // ── Terminal ──────────────────────────────────────────────────────────────────
  handle(CH.TERMINAL_CREATE, (_event, projectPath: string) => {
    const id = crypto.randomUUID();
    const shell = process.env.SHELL ?? "/bin/bash";
    const extraPaths = ["/usr/bin", "/usr/local/bin", "/opt/homebrew/bin"].join(":");
    const env = { ...process.env, PATH: `${extraPaths}:${process.env.PATH ?? ""}` } as Record<string, string>;

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
  handle(CH.GET_TRACES, (_event, sessionId?: string) => getSpans(sessionId));

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
  handle(CH.CREATE_SESSION, (_event, projectId: string) => {
    // Inherit the project's current provider + model so new sessions start
    // with the right model without the user having to configure it again.
    const project = listProjects(db).find((p) => p.id === projectId);
    return createSession(db, projectId, project?.config.provider ?? null, project?.config.model ?? null);
  });
  handle(CH.LIST_SESSIONS, (_event, projectId: string) =>
    listSessions(db, projectId)
  );
  handle(CH.GET_SESSION, (_event, sessionId: string) =>
    getSession(db, sessionId)
  );
  handle(CH.DELETE_SESSION, (_event, sessionId: string) =>
    deleteSession(db, sessionId)
  );
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

  // ── File system ───────────────────────────────────────────────────────────────
  handle(CH.LIST_DIRECTORY, (_event, dirPath: string) => {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true }).map((dirent) => {
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
      return { entries };
    } catch (err) {
      if (err instanceof Error && ("code" in err) && (err as NodeJS.ErrnoException).code === "ENOENT" || (err as NodeJS.ErrnoException).code === "EACCES") {
        return { entries: [] };
      }
      return { entries: [] };
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
  handle(CH.AGENT_SEND, async (_event, args: { sessionId: string; prompt: string; agent?: string }) => {
    const win = getMainWindow();
    if (!win) throw new Error("No window available");
    const session = getSession(db, args.sessionId);
    const project = listProjects(db).find((p) => p.id === session.project_id);
    if (!project) throw new Error(`Project not found for session ${args.sessionId}`);
    const effectiveConfig = {
      ...project.config,
      provider: session.provider ?? project.config.provider,
      model: session.model ?? project.config.model,
    };
    await runAgentTurn({
      db,
      sessionId: args.sessionId,
      prompt: args.prompt,
      projectPath: project.path,
      projectConfig: effectiveConfig,
      webContents: win.webContents,
      agent: args.agent ?? session.agent ?? undefined,
      skills: session.skills ?? undefined,
    });
  });
  handle(CH.GET_COPILOT_MODELS, () => getProvider("copilot").listModels?.());
  handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getProvider("anthropic").listAgents?.(projectPath);
  });
  handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return getProvider("copilot").listAgents?.(projectPath);
  });
  handle(CH.LIST_SKILLS, (_event, projectPath: string) => {
    const projectSkillsDir = path.join(projectPath, ".agents", "skills");
    const globalSkillsDir = path.join(os.homedir(), ".claude", "skills");

    const projectSkills = scanSkillsDir(projectSkillsDir);
    const globalSkills = scanSkillsDir(globalSkillsDir);

    // Project-local skills take priority — skip globals with the same name
    const projectNames = new Set(projectSkills.map((s) => s.name));
    return [...projectSkills, ...globalSkills.filter((s) => !projectNames.has(s.name))];
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
  registerHandlers();
  createWindow();

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
