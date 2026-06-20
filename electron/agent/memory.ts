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

/**
 * Per-file cap on memory content injected into the system prompt. A single
 * oversized memory file would bloat every request and degrade reliability, so
 * we read at most this many bytes and mark the file as truncated.
 */
const MAX_MEMORY_FILE_BYTES = 64 * 1024;

/** `~/.aichemist/memory/<sanitized-cwd>` for the given project. */
export function memoryDir(projectPath: string): string {
  return path.join(os.homedir(), ".aichemist", "memory", sanitizeCwd(projectPath));
}

/**
 * Resolve a memory file name to an absolute path inside the project's memory
 * directory. The store is intentionally FLAT — `listMemoryFiles` only reads the
 * top level, so a nested name would write a file that is never listed or
 * injected. We therefore require a bare `.md` filename and reject any name with
 * a path separator, `..`, or other directory component (which also blocks
 * traversal outright). A defensive boundary check remains as a backstop.
 */
function resolveMemoryFile(projectPath: string, name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Memory file name is required");
  }
  if (trimmed.includes("/") || trimmed.includes("\\") || path.basename(trimmed) !== trimmed) {
    throw new Error(`Memory file name must be a flat filename, not a path: "${name}"`);
  }
  if (!trimmed.toLowerCase().endsWith(".md")) {
    throw new Error(`Memory files must be markdown (.md): "${name}"`);
  }
  const dir = memoryDir(projectPath);
  const resolved = path.resolve(dir, trimmed);
  if (!resolved.startsWith(dir + path.sep)) {
    throw new Error(`Memory path escapes the memory directory: "${name}"`);
  }
  return resolved;
}

/**
 * Throw if `file` exists and is anything other than a regular file (e.g. a
 * symlink planted to point at a sensitive location). Returns the `lstat` result
 * when the file exists, or `null` when it does not — without following links.
 */
function assertRegularFileIfExists(file: string): fs.Stats | null {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null; // does not exist
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`Memory entry is not a regular file: "${path.basename(file)}"`);
  }
  return stat;
}

/**
 * List the project's memory files: top-level `.md` regular files only, sorted
 * case-insensitively. Symlinks and directories are excluded so a planted link
 * never surfaces in the viewer or the injected context.
 */
export function listMemoryFiles(projectPath: string): MemoryFile[] {
  const dir = memoryDir(projectPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((name) => ({ name, path: path.join(dir, name) }));
}

/**
 * Write a memory file, creating the memory directory as needed. Refuses to
 * write through a pre-existing symlink (or any non-regular file), so a planted
 * link can't redirect an un-gated `write_memory` onto an arbitrary target.
 */
export function implWriteMemory(projectPath: string, name: string, content: string): string {
  const file = resolveMemoryFile(projectPath, name);
  assertRegularFileIfExists(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return `Memory saved: ${path.basename(file)}`;
}

/**
 * Read a memory file's content. Throws if it does not exist or is not a regular
 * file — symlinks are refused so `read_memory` can't follow a planted link to
 * exfiltrate a sensitive file.
 */
export function implReadMemory(projectPath: string, name: string): string {
  const file = resolveMemoryFile(projectPath, name);
  const stat = assertRegularFileIfExists(file);
  if (!stat) {
    throw new Error(`Memory file not found: "${path.basename(file)}"`);
  }
  return fs.readFileSync(file, "utf8");
}

/**
 * Delete a memory file. Throws if it does not exist or is not a regular file —
 * symlinks are refused so `delete_memory` can't unlink an arbitrary target via
 * a planted link.
 */
export function implDeleteMemory(projectPath: string, name: string): string {
  const file = resolveMemoryFile(projectPath, name);
  const stat = assertRegularFileIfExists(file);
  if (!stat) {
    throw new Error(`Memory file not found: "${path.basename(file)}"`);
  }
  fs.unlinkSync(file);
  return `Memory deleted: ${path.basename(file)}`;
}

/**
 * Read at most `cap` bytes from a file without loading the whole thing into
 * memory. Returns the decoded text and whether the file exceeded the cap.
 */
function readCapped(filePath: string, cap: number): { text: string; truncated: boolean } {
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(cap);
    const bytesRead = fs.readSync(fd, buf, 0, cap, 0);
    const size = fs.fstatSync(fd).size;
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: size > cap };
  } finally {
    fs.closeSync(fd);
  }
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
      // listMemoryFiles already excludes symlinks, but re-check by reading at
      // most MAX_MEMORY_FILE_BYTES so a single huge file can't bloat the prompt.
      const { text, truncated } = readCapped(file.path, MAX_MEMORY_FILE_BYTES);
      body = text.trim();
      if (truncated) {
        body += "\n\n…[memory file truncated]";
      }
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
