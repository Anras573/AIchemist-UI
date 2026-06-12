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
export function registerLibraryHandlers(): void {
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
      assertSafeName(args.name);
      const filePath = agentFilePathFor(args);
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
        /** Determines the global skills dir — Copilot scans ~/.agents/skills,
         *  everything else uses ~/.claude/skills (must match listSkills()). */
        provider?: string;
      }
    ) => {
      assertSafeName(args.name);
      const skillPath = skillPathFor(args);
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(path.join(skillPath, "SKILL.md"), args.content, "utf8");
      return { skillPath };
    }
  );
}
