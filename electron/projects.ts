import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { Database } from "better-sqlite3";
import type { Project, ProjectConfig } from "../src/types/index";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function configPath(projectPath: string): string {
  return path.join(projectPath, ".aichemist", "config.json");
}

function defaultProjectConfig(): ProjectConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    approval_mode: "custom",
    approval_rules: [
      { tool_category: "filesystem", policy: "risky_only" },
      { tool_category: "shell", policy: "always" },
      { tool_category: "web", policy: "never" },
    ],
    custom_tools: [],
  };
}

function readOrCreateConfig(projectPath: string): ProjectConfig {
  const cfgPath = configPath(projectPath);
  if (fs.existsSync(cfgPath)) {
    try {
      const raw = fs.readFileSync(cfgPath, "utf-8");
      return JSON.parse(raw) as ProjectConfig;
    } catch {
      return defaultProjectConfig();
    }
  }

  const config = defaultProjectConfig();
  const dir = path.dirname(cfgPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");
  return config;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Exported functions ──────────────────────────────────────────────────────

/**
 * Open a folder as a project. Creates `.aichemist/config.json` if absent.
 */
export function addProject(db: Database, projectPath: string): Project {
  const trimmedPath = projectPath.replace(/\/+$/, "");

  if (!fs.existsSync(trimmedPath) || !fs.statSync(trimmedPath).isDirectory()) {
    throw new Error(`Path is not a directory: ${trimmedPath}`);
  }

  const name = path.basename(trimmedPath) || "Project";
  const config = readOrCreateConfig(trimmedPath);
  const id = crypto.randomUUID();
  const createdAt = nowIso();

  // INSERT OR IGNORE so re-opening an existing project is a no-op on the DB level
  db.prepare(
    "INSERT OR IGNORE INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)"
  ).run(id, name, trimmedPath, createdAt);

  // Fetch the canonical row (handles the case where the project already existed)
  const row = db
    .prepare("SELECT id, name, path, created_at FROM projects WHERE path = ?")
    .get(trimmedPath) as { id: string; name: string; path: string; created_at: string };

  return {
    id: row.id,
    name: row.name,
    path: row.path,
    created_at: row.created_at,
    config,
  };
}

/**
 * Return all known projects, ordered by creation date.
 */
export function listProjects(db: Database): Project[] {
  const rows = db
    .prepare("SELECT id, name, path, created_at FROM projects ORDER BY created_at ASC")
    .all() as { id: string; name: string; path: string; created_at: string }[];

  return rows.map((row) => {
    const config = readOrCreateConfig(row.path);
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      created_at: row.created_at,
      config,
    };
  });
}

/**
 * Remove a project from the registry. Does NOT delete the folder.
 */
export function removeProject(db: Database, id: string): void {
  db.prepare("DELETE FROM projects WHERE id = ?").run(id);
}

/**
 * Read `.aichemist/config.json` for a project.
 */
export function getProjectConfig(db: Database, id: string): ProjectConfig {
  const row = db
    .prepare("SELECT path FROM projects WHERE id = ?")
    .get(id) as { path: string } | undefined;

  if (!row) {
    throw new Error(`Project not found: ${id}`);
  }

  return readOrCreateConfig(row.path);
}

/**
 * Write `.aichemist/config.json` for a project.
 */
export function saveProjectConfig(
  db: Database,
  id: string,
  config: ProjectConfig
): void {
  const row = db
    .prepare("SELECT path FROM projects WHERE id = ?")
    .get(id) as { path: string } | undefined;

  if (!row) {
    throw new Error(`Project not found: ${id}`);
  }

  const cfgPath = configPath(row.path);
  const dir = path.dirname(cfgPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(config, null, 2), "utf-8");
}
