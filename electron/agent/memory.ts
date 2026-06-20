/**
 * Project memory store for the self-driven providers (Ollama, OpenAI-compatible).
 *
 * Unlike Claude — whose memory files are owned and written by the Claude Code
 * SDK under `~/.claude/projects/<sanitized-cwd>/memory/` — the native providers
 * have no SDK-managed memory. This module gives them an equivalent: a
 * project-scoped store of `.md` files that the model maintains via memory tools
 * and that we inject into the system prompt each turn.
 *
 *   ~/.aichemist/memory/<sanitized-cwd>/*.md
 *
 * The store lives under AIchemist's own data dir (mirroring
 * `~/.aichemist/traces/<sessionId>/`), NOT inside the project — so the regular
 * project-boundary FS validators in `tool-impls.ts` do not apply here. This
 * module carries its own boundary check anchored to the memory directory, and
 * memory writes intentionally do not produce a `FileChange` (they are not
 * project edits and must stay out of the Changes tab).
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { sanitizeCwd } from "../claude-transcript";

export interface MemoryFile {
  name: string;
  path: string;
}

/** `~/.aichemist/memory/<sanitized-cwd>` for the given project. */
export function memoryDir(projectPath: string): string {
  return path.join(os.homedir(), ".aichemist", "memory", sanitizeCwd(projectPath));
}

/**
 * Resolve a memory file name against the project's memory directory, rejecting
 * anything that escapes it or isn't a `.md` file. The name is treated as a path
 * relative to `memoryDir` — `..` traversal and absolute paths that land outside
 * the directory are refused.
 */
function resolveMemoryFile(projectPath: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Memory file name is required");
  }
  const dir = memoryDir(projectPath);
  const resolved = path.resolve(dir, trimmed);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`Memory path escapes the memory directory: "${name}"`);
  }
  if (!resolved.toLowerCase().endsWith(".md")) {
    throw new Error(`Memory files must be markdown (.md): "${name}"`);
  }
  return resolved;
}

/** List the project's memory files (`.md` only), sorted case-insensitively. */
export function listMemoryFiles(projectPath: string): MemoryFile[] {
  const dir = memoryDir(projectPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.toLowerCase().endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name, path: path.join(dir, name) }));
}

/** Write a memory file, creating the memory directory as needed. */
export function implWriteMemory(projectPath: string, name: string, content: string): string {
  const file = resolveMemoryFile(projectPath, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return `Memory saved: ${path.basename(file)}`;
}

/** Read a memory file's content. Throws if it does not exist. */
export function implReadMemory(projectPath: string, name: string): string {
  return fs.readFileSync(resolveMemoryFile(projectPath, name), "utf8");
}

/** Delete a memory file. Throws if it does not exist. */
export function implDeleteMemory(projectPath: string, name: string): string {
  const file = resolveMemoryFile(projectPath, name);
  fs.unlinkSync(file);
  return `Memory deleted: ${path.basename(file)}`;
}

/**
 * Build a `# Project Memory` block to inject into the system prompt, mirroring
 * `buildSkillsContext`. Returns an empty string when there are no memory files
 * (or all are empty/unreadable).
 */
export function buildMemoryContext(projectPath: string): string {
  const files = listMemoryFiles(projectPath);
  if (files.length === 0) return "";

  const blocks: string[] = [];
  for (const file of files) {
    let body = "";
    try {
      body = fs.readFileSync(file.path, "utf8").trim();
    } catch {
      // unreadable file — skip it
    }
    if (body) {
      blocks.push(`## Memory: ${file.name}\n\n${body}`);
    }
  }

  if (blocks.length === 0) return "";

  return (
    "\n\n---\n# Project Memory\n\n" +
    "Notes you previously saved for this project. Use write_memory to persist " +
    "durable facts (conventions, decisions, gotchas) and keep them up to date.\n\n" +
    blocks.join("\n\n---\n\n")
  );
}
