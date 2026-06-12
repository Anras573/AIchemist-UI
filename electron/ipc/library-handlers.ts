import type { Database } from "better-sqlite3";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as CH from "../ipc-channels";
import { globalSkillsDir } from "../skills-discovery";
import { handle } from "./handle";

/**
 * Rejects names that could change the target directory when joined into a
 * path. The renderer validates too, but the main process is the trust
 * boundary — a compromised renderer (or a future call site without UI
 * validation) must not be able to write outside the library directories.
 */
export function assertSafeName(name: string): void {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name !== path.basename(name)
  ) {
    throw new Error(`Invalid name "${name}" — must be a plain file name without path separators`);
  }
}

/** Directories the agent/skill library operations are allowed to touch. */
export interface LibraryRoots {
  /** Dirs that directly contain agent `.md` files. */
  agents: string[];
  /** Dirs that directly contain skill directories. */
  skills: string[];
}

/** Library roots for a set of project/worktree paths (pure, for tests). */
export function libraryRootsFor(projectPaths: string[]): LibraryRoots {
  const agents = [
    path.join(os.homedir(), ".claude", "agents"),
    path.join(os.homedir(), ".github-copilot", "agents"),
  ];
  const skills = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".agents", "skills"),
  ];
  for (const projectPath of projectPaths) {
    agents.push(path.join(projectPath, ".agents", "copilot-agents"));
    skills.push(path.join(projectPath, ".agents", "skills"));
  }
  return { agents, skills };
}

/**
 * Roots derived from the registered projects and session worktrees in the DB
 * plus the fixed per-user dirs — the main process's own source of truth, so a
 * renderer-supplied path cannot widen the allowed set.
 */
function collectLibraryRoots(db: Database): LibraryRoots {
  const projectPaths = (
    db.prepare("SELECT path FROM projects").all() as Array<{ path: string }>
  ).map((row) => row.path);
  const workspacePaths = (
    db
      .prepare("SELECT DISTINCT workspace_path FROM sessions WHERE workspace_path IS NOT NULL")
      .all() as Array<{ workspace_path: string }>
  ).map((row) => row.workspace_path);
  return libraryRootsFor([...projectPaths, ...workspacePaths]);
}

/**
 * Asserts `target` resolves to a direct child of one of `roots` and returns
 * the resolved path. Every legitimate library operation targets a direct
 * child (an agent `.md` file or a skill directory), so anything else —
 * `..` traversal, the root itself, nested paths — is rejected.
 */
export function assertDirectChildOfRoots(target: string, roots: string[], label: string): string {
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  if (!roots.some((root) => parent === path.resolve(root))) {
    throw new Error(`Refusing to touch ${label} outside the library directories: "${target}"`);
  }
  return resolved;
}

/**
 * Where a newly created agent file goes. Copilot has its own agent dirs;
 * every other provider (anthropic, ollama) reads Claude agent files from
 * `~/.claude/agents` via `readAgentFileSystemPrompt()`, so creation must
 * write there for the agent to be discoverable.
 */
export function agentFilePathFor(args: {
  provider: string;
  name: string;
  projectPath: string;
  scope: "global" | "project";
}): string {
  if (args.provider === "copilot") {
    return args.scope === "project"
      ? path.join(args.projectPath, ".agents", "copilot-agents", `${args.name}.md`)
      : path.join(os.homedir(), ".github-copilot", "agents", `${args.name}.md`);
  }
  return path.join(os.homedir(), ".claude", "agents", `${args.name}.md`);
}

/** Where a newly created skill directory goes (must match listSkills() scans). */
export function skillPathFor(args: {
  name: string;
  projectPath: string;
  scope: "global" | "project";
  provider?: string;
}): string {
  return args.scope === "project"
    ? path.join(args.projectPath, ".agents", "skills", args.name)
    : path.join(globalSkillsDir(args.provider), args.name);
}

/**
 * IPC handlers for the user's agent/skill library: creating, writing and
 * deleting the markdown files behind the Agents picker and Skills panel.
 * Turn execution lives in agent-handlers.ts; discovery in skills-discovery.ts.
 */
export function registerLibraryHandlers(db: Database): void {
  handle(
    CH.WRITE_AGENT_FILE,
    (_event, args: { filePath: string; content: string }) => {
      const filePath = assertDirectChildOfRoots(args.filePath, collectLibraryRoots(db).agents, "agent file");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, "utf8");
    }
  );
  handle(CH.DELETE_AGENT_FILE, (_event, filePath: string) => {
    fs.unlinkSync(assertDirectChildOfRoots(filePath, collectLibraryRoots(db).agents, "agent file"));
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
      assertSafeName(args.name);
      const filePath = assertDirectChildOfRoots(
        agentFilePathFor(args),
        collectLibraryRoots(db).agents,
        "agent file"
      );
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, args.content, "utf8");
      return { filePath };
    }
  );
  handle(
    CH.WRITE_SKILL_FILE,
    (_event, args: { skillPath: string; content: string }) => {
      const skillPath = assertDirectChildOfRoots(args.skillPath, collectLibraryRoots(db).skills, "skill directory");
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, "SKILL.md"), args.content, "utf8");
    }
  );
  handle(CH.DELETE_SKILL_DIR, (_event, skillPath: string) => {
    fs.rmSync(assertDirectChildOfRoots(skillPath, collectLibraryRoots(db).skills, "skill directory"), {
      recursive: true,
      force: true,
    });
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
        /** Determines the global skills dir — Copilot scans ~/.agents/skills,
         *  everything else uses ~/.claude/skills (must match listSkills()). */
        provider?: string;
      }
    ) => {
      assertSafeName(args.name);
      const skillPath = assertDirectChildOfRoots(
        skillPathFor(args),
        collectLibraryRoots(db).skills,
        "skill directory"
      );
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, "SKILL.md"), args.content, "utf8");
      return { skillPath };
    }
  );
}
