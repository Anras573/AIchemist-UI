import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import { shell } from "electron";
import * as CH from "../ipc-channels";
import { buildChildProcessPath } from "../config";
import { openFolderDialog } from "../dialog";
import { handle } from "./handle";

const IGNORED_DIR_NAMES = new Set([
  "node_modules", ".git", ".hg", ".svn",
  "dist", "build", "out", ".next", ".nuxt", ".turbo",
  "__pycache__", ".cache", ".parcel-cache", ".vite",
  "coverage", ".nyc_output",
]);
const MAX_DIR_ENTRIES = 500;

export function registerFsHandlers(): void {
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
    const MAX_BYTES = 512 * 1024;
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_BYTES) {
        return { error: `File too large (${Math.round(stat.size / 1024)} KB). Only files under 512 KB can be previewed.` };
      }
      const buf = fs.readFileSync(filePath);
      const checkLen = Math.min(buf.length, 8192);
      for (let i = 0; i < checkLen; i++) {
        if (buf[i] === 0) return { error: "Binary file — cannot display as text." };
      }
      return { content: buf.toString("utf8") };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  handle(CH.OPEN_FOLDER_DIALOG, () => openFolderDialog());

  handle(CH.OPEN_GITHUB_URL, async (_event, rawUrl: string) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Invalid URL");
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "github.com" && host !== "www.github.com")) {
      throw new Error("Only GitHub HTTPS URLs can be opened");
    }
    await shell.openExternal(url.toString());
  });

  handle(CH.GET_GIT_BRANCH, (_event, projectPath: string) => {
    const env = { ...process.env, PATH: buildChildProcessPath(process.env.PATH) };
    try {
      return childProcess
        .execSync("git branch --show-current", { cwd: projectPath, encoding: "utf8", timeout: 5_000, env })
        .trim() || null;
    } catch {
      return null;
    }
  });

  handle(CH.GET_GIT_DIFF, (_event, projectPath: string) => {
    const env = { ...process.env, PATH: buildChildProcessPath(process.env.PATH) };

    const run = (cmd: string) =>
      childProcess.execSync(cmd, { cwd: projectPath, encoding: "utf8", timeout: 10_000, env });

    try {
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
}
