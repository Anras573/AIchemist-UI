import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as CH from "../ipc-channels";
import { handle } from "./handle";

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
