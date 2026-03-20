import { app, BrowserWindow, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import * as CH from "./ipc-channels";
import { loadEnv, getApiKey, getAnthropicConfig } from "./config";
import { openDb } from "./db";
import { addProject, listProjects, removeProject, getProjectConfig, saveProjectConfig } from "./projects";
import { createSession, listSessions, getSession, deleteSession, saveMessage, updateSessionTitle, updateSessionModel } from "./sessions";
import { openFolderDialog } from "./dialog";
import { readSettings, writeSettings } from "./settings";
import type { SettingsMap } from "./settings";
import { resolvePendingApproval } from "./agent/mcp-tools";
import { runAgentTurn } from "./agent/runner";
import { getClaudeAgents } from "./agent/claude";
import { stopCopilotClient, resolveCopilotApproval, getCopilotModels } from "./agent/copilot";
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

function registerHandlers(): void {
  // ── Settings ─────────────────────────────────────────────────────────────────
  ipcMain.handle(CH.SETTINGS_READ, () => readSettings());
  ipcMain.handle(CH.SETTINGS_WRITE, (_event, updates: Partial<SettingsMap>) =>
    writeSettings(updates)
  );

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
    // Session-level model overrides project default; fall back to project config for legacy sessions
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
      agent: args.agent,
    });
  });
  ipcMain.handle(CH.GET_COPILOT_MODELS, () => getCopilotModels());
  ipcMain.handle(CH.GET_CLAUDE_AGENTS, async (_event, projectPath: string) => {
    return getClaudeAgents(projectPath);
  });
  ipcMain.handle(CH.LIST_SKILLS, (_event, projectPath: string) => {
    const skillsDir = path.join(projectPath, ".agents", "skills");
    try {
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((dir) => {
          const skillPath = path.join(skillsDir, dir.name);
          let description = "";
          const readmePath = path.join(skillPath, "README.md");
          try {
            const content = fs.readFileSync(readmePath, "utf8");
            // First non-empty, non-heading line becomes the description
            const lines = content.split("\n");
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed && !trimmed.startsWith("#")) {
                description = trimmed.slice(0, 150);
                break;
              }
            }
          } catch {
            // no README — description stays empty
          }
          return { name: dir.name, description, path: skillPath };
        });
    } catch {
      return [];
    }
  });
  ipcMain.handle(
    CH.APPROVE_TOOL_CALL,
    (_event, args: { sessionId: string; approvalId: string; approved: boolean }) => {
      resolvePendingApproval(args.approvalId, args.approved);
      resolveCopilotApproval(args.approvalId, args.approved);
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

app.on("before-quit", () => { void stopCopilotClient(); });
