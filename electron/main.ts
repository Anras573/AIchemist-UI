import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as CH from "./ipc-channels";
import { loadEnv, getApiKey, getAnthropicConfig } from "./config";
import { openDb } from "./db";
import { addProject, listProjects, removeProject, getProjectConfig, saveProjectConfig } from "./projects";
import { createSession, listSessions, getSession, deleteSession, saveMessage, updateSessionTitle, updateSessionModel, updateSessionAgent, updateSessionSkills } from "./sessions";
import { openFolderDialog } from "./dialog";
import { readSettings, writeSettings } from "./settings";
import type { SettingsMap } from "./settings";
import { resolveApproval } from "./agent/approval";
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

function registerHandlers(): void {  // ── Settings ─────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.SETTINGS_READ, () => readSettings());
  ipcMain.handle(CH.SETTINGS_WRITE, (_event, updates: Partial<SettingsMap>) =>
    writeSettings(updates)
  );

  // ── Traces ───────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.GET_TRACES, (_event, sessionId?: string) => getSpans(sessionId));

  // ── Config ──────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.GET_API_KEY, (_event, provider: string) =>
    getApiKey(provider)
  );
  ipcMain.handle(CH.GET_ANTHROPIC_CONFIG, () => getAnthropicConfig());

  // ── Projects ─────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.ADD_PROJECT, async (_event, projectPath: string) => {
    try {
      return addProject(db, projectPath);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(CH.LIST_PROJECTS, () => listProjects(db));
  ipcMain.handle(CH.REMOVE_PROJECT, (_event, id: string) =>
    removeProject(db, id)
  );
  ipcMain.handle(CH.GET_PROJECT_CONFIG, (_event, id: string) =>
    getProjectConfig(db, id)
  );
  ipcMain.handle(
    CH.SAVE_PROJECT_CONFIG,
    (_event, id: string, config: ProjectConfig) =>
      saveProjectConfig(db, id, config)
  );

  // ── Sessions ─────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.CREATE_SESSION, (_event, projectId: string) => {
    // Inherit the project's current provider + model so new sessions start
    // with the right model without the user having to configure it again.
    const project = listProjects(db).find((p) => p.id === projectId);
    return createSession(db, projectId, project?.config.provider ?? null, project?.config.model ?? null);
  });
  ipcMain.handle(CH.LIST_SESSIONS, (_event, projectId: string) =>
    listSessions(db, projectId)
  );
  ipcMain.handle(CH.GET_SESSION, (_event, sessionId: string) =>
    getSession(db, sessionId)
  );
  ipcMain.handle(CH.DELETE_SESSION, (_event, sessionId: string) =>
    deleteSession(db, sessionId)
  );
  ipcMain.handle(
    CH.SAVE_MESSAGE,
    (_event, args: { sessionId: string; role: string; content: string }) =>
      saveMessage(db, args)
  );
  ipcMain.handle(
    CH.UPDATE_SESSION_TITLE,
    (_event, sessionId: string, title: string) =>
      updateSessionTitle(db, sessionId, title)
  );
  ipcMain.handle(
    CH.UPDATE_SESSION_MODEL,
    (_event, sessionId: string, provider: string, model: string) =>
      updateSessionModel(db, sessionId, provider, model)
  );
  ipcMain.handle(
    CH.UPDATE_SESSION_AGENT,
    (_event, sessionId: string, agent: string | null) =>
      updateSessionAgent(db, sessionId, agent)
  );
  ipcMain.handle(
    CH.UPDATE_SESSION_SKILLS,
    (_event, sessionId: string, skills: string[]) =>
      updateSessionSkills(db, sessionId, skills)
  );

  // ── File system ───────────────────────────────────────────────────────────────
  ipcMain.handle(CH.LIST_DIRECTORY, (_event, dirPath: string) => {
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

  ipcMain.handle(CH.READ_FILE, (_event, filePath: string) => {
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
  ipcMain.handle(CH.OPEN_FOLDER_DIALOG, () => openFolderDialog());

  // ── Agent ─────────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.AGENT_SEND, async (_event, args: { sessionId: string; prompt: string; agent?: string }) => {
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
  ipcMain.handle(CH.GET_COPILOT_MODELS, () => getProvider("copilot").listModels?.());
  ipcMain.handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getProvider("anthropic").listAgents?.(projectPath);
  });
  ipcMain.handle(CH.GET_COPILOT_AGENTS, async (_event, projectPath: string) => {
    return getProvider("copilot").listAgents?.(projectPath);
  });
  ipcMain.handle(CH.LIST_SKILLS, (_event, projectPath: string) => {
    const projectSkillsDir = path.join(projectPath, ".agents", "skills");
    const globalSkillsDir = path.join(os.homedir(), ".claude", "skills");

    const projectSkills = scanSkillsDir(projectSkillsDir);
    const globalSkills = scanSkillsDir(globalSkillsDir);

    // Project-local skills take priority — skip globals with the same name
    const projectNames = new Set(projectSkills.map((s) => s.name));
    return [...projectSkills, ...globalSkills.filter((s) => !projectNames.has(s.name))];
  });
  ipcMain.handle(
    CH.APPROVE_TOOL_CALL,
    (_event, args: { sessionId: string; approvalId: string; approved: boolean }) => {
      resolveApproval(args.approvalId, args.approved);
    }
  );

  // ── Agent / Skill file management ──────────────────────────────────────────
  ipcMain.handle(
    CH.WRITE_AGENT_FILE,
    (_event, args: { filePath: string; content: string }) => {
      fs.mkdirSync(path.dirname(args.filePath), { recursive: true });
      fs.writeFileSync(args.filePath, args.content, "utf8");
    }
  );
  ipcMain.handle(CH.DELETE_AGENT_FILE, (_event, filePath: string) => {
    fs.unlinkSync(filePath);
  });
  ipcMain.handle(
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
  ipcMain.handle(
    CH.WRITE_SKILL_FILE,
    (_event, args: { skillPath: string; content: string }) => {
      fs.mkdirSync(args.skillPath, { recursive: true });
      fs.writeFileSync(path.join(args.skillPath, "SKILL.md"), args.content, "utf8");
    }
  );
  ipcMain.handle(CH.DELETE_SKILL_DIR, (_event, skillPath: string) => {
    fs.rmSync(skillPath, { recursive: true, force: true });
  });
  ipcMain.handle(
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
  // Gracefully shut down all providers that implement stop()
  for (const name of ["copilot", "anthropic"]) {
    try {
      void getProvider(name).stop?.();
    } catch {
      // Provider may not be registered; ignore
    }
  }
});
