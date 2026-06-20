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

import * as crypto from "crypto";
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

/**
 * Cap on a single `write_memory` payload. The tool is un-gated, so without a
 * limit a runaway model could fill the disk. Generous relative to the 64 KB
 * injection cap, but bounded.
 */
const MAX_MEMORY_WRITE_BYTES = 256 * 1024;

/**
 * Caps on the *combined* memory block injected each turn. Even with a per-file
 * cap, many small files could bloat the prompt and blow the context window, so
 * we stop after MAX_MEMORY_TOTAL_BYTES or MAX_MEMORY_FILES and mark it truncated.
 */
const MAX_MEMORY_TOTAL_BYTES = 128 * 1024;
const MAX_MEMORY_FILES = 32;

/** `O_NOFOLLOW` where supported (POSIX); 0 elsewhere so the open still works. */
const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** Test seam: overrides the `~/.aichemist` base so tests can use a temp dir. */
let aichemistDirOverride: string | null = null;

/** Override the AIchemist base directory (testing only). Pass `null` to reset. */
export function _setMemoryRootForTests(dir: string | null): void {
  aichemistDirOverride = dir;
}

/** The AIchemist base dir (`~/.aichemist`), or the test override when set. */
function aichemistDir(): string {
  return aichemistDirOverride ?? path.join(os.homedir(), ".aichemist");
}

/** Is `err` a "no such file/directory" (ENOENT) error? */
function isEnoent(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

/** `~/.aichemist/memory/<sanitized-cwd>` for the given project. */
export function memoryDir(projectPath: string): string {
  // sanitizeCwd can yield "" for inputs like "/" (all chars stripped). An empty
  // segment would collapse the store to a single shared dir and collide across
  // projects, so fall back to a deterministic per-path hash — unique and stable
  // for that project, and still usable for root-level projects.
  const sanitized = sanitizeCwd(projectPath) || hashedSegment(projectPath);
  return path.join(aichemistDir(), "memory", sanitized);
}

/** Deterministic non-empty dir segment derived from the raw project path. */
function hashedSegment(projectPath: string): string {
  return `_${crypto.createHash("sha256").update(projectPath).digest("hex").slice(0, 16)}`;
}

/**
 * Verify no component of the memory directory chain (`~/.aichemist`,
 * `~/.aichemist/memory`, and the per-project dir) is a symlink or a non-directory.
 * A symlinked ancestor could redirect the whole store outside `~/.aichemist`
 * (e.g. into the project tree, which writes deliberately keep out of the Changes
 * tab). Missing components are fine — they'll be created as real dirs. Returns
 * the per-project memory dir.
 */
function assertMemoryDirChainSafe(projectPath: string): string {
  const base = aichemistDir();
  const dir = memoryDir(projectPath);
  for (const seg of [base, path.join(base, "memory"), dir]) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(seg);
    } catch (err) {
      if (isEnoent(err)) continue; // doesn't exist yet — created as a real dir
      throw err; // permission / IO error — surface it rather than skip the check
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to use a symlinked memory directory: "${seg}"`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`Memory path is not a directory: "${seg}"`);
    }
  }
  return dir;
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
  const dir = assertMemoryDirChainSafe(projectPath);
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
  } catch (err) {
    if (isEnoent(err)) return null; // does not exist
    throw err; // permission / IO error — don't misreport as "not found"
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
  let dir: string;
  let entries: fs.Dirent[];
  try {
    // Bail (empty list) if the dir is missing, not a directory, or a symlink —
    // a symlinked memory dir could otherwise surface arbitrary .md files.
    dir = assertMemoryDirChainSafe(projectPath);
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
 * write through a pre-existing symlink, so a planted link can't redirect an
 * un-gated `write_memory` onto an arbitrary target. The file is created 0600
 * (owner-only) since memory may hold sensitive notes.
 */
export function implWriteMemory(projectPath: string, name: string, content: string): string {
  if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_WRITE_BYTES) {
    throw new Error(
      `Memory content exceeds the ${Math.round(MAX_MEMORY_WRITE_BYTES / 1024)} KB limit`,
    );
  }
  // resolveMemoryFile validates the directory chain has no symlinked ancestors.
  const file = resolveMemoryFile(projectPath, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // O_NOFOLLOW degrades to 0 on platforms without it (e.g. Windows), where the
  // open would follow a planted symlink — fall back to an lstat check there.
  if (O_NOFOLLOW === 0) assertRegularFileIfExists(file);
  // O_NOFOLLOW makes the open fail if `file` is an existing symlink, closing the
  // TOCTOU window an lstat-then-write would leave open. O_CREAT|O_TRUNC give the
  // overwrite semantics; fstat confirms a regular file before writing.
  const fd = fs.openSync(
    file,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | O_NOFOLLOW,
    0o600,
  );
  try {
    if (!fs.fstatSync(fd).isFile()) {
      throw new Error(`Memory entry is not a regular file: "${path.basename(file)}"`);
    }
    // The 0o600 mode above only applies when the file is newly created; an
    // existing file keeps its prior (possibly world-readable) permissions. Force
    // owner-only on the open FD so a rewrite tightens perms too. Best-effort —
    // platforms without chmod semantics (e.g. Windows) throw, which we ignore.
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      // ignore — not supported on this platform
    }
    fs.writeSync(fd, content, null, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return `Memory saved: ${path.basename(file)}`;
}

/**
 * Read a memory file's content. Throws if it does not exist or is not a regular
 * file. Routes through `readCapped` (O_NOFOLLOW + fstat), so a symlink swapped
 * in after resolution fails the open rather than being followed — closing the
 * TOCTOU window an lstat-then-readFileSync would leave. Content is bounded to
 * MAX_MEMORY_WRITE_BYTES (the largest we ever write) with a truncation marker.
 */
export function implReadMemory(projectPath: string, name: string): string {
  const file = resolveMemoryFile(projectPath, name);
  let result: { text: string; truncated: boolean };
  try {
    result = readCapped(file, MAX_MEMORY_WRITE_BYTES);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Memory file not found: "${path.basename(file)}"`);
    }
    throw err;
  }
  return result.truncated ? `${result.text}\n\n…[memory file truncated]` : result.text;
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
 * memory. Opens with `O_NOFOLLOW` so a symlink at `filePath` fails the open
 * (TOCTOU-safe between listing and read), then `fstat`s the opened descriptor
 * to confirm it's a regular file. Returns the decoded text and whether the file
 * exceeded the cap.
 */
function readCapped(filePath: string, cap: number): { text: string; truncated: boolean } {
  // O_NOFOLLOW degrades to 0 on platforms without it (e.g. Windows); fall back to
  // an lstat check so a planted symlink is still refused. lstat throws ENOENT for
  // a missing file, which callers map to "not found".
  if (O_NOFOLLOW === 0) {
    const st = fs.lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new Error(`Not a regular file: "${path.basename(filePath)}"`);
    }
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Not a regular file: "${path.basename(filePath)}"`);
    }
    const buf = Buffer.alloc(cap);
    const bytesRead = fs.readSync(fd, buf, 0, cap, 0);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: stat.size > cap };
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
  let totalBytes = 0;
  let truncatedBlock = false;
  for (const file of files) {
    if (blocks.length >= MAX_MEMORY_FILES) {
      truncatedBlock = true;
      break;
    }
    let body = "";
    try {
      // readCapped re-checks (O_NOFOLLOW + fstat) that the entry is still a
      // regular file at open time and reads at most MAX_MEMORY_FILE_BYTES, so a
      // symlink swapped in after listing is refused and one huge file can't
      // bloat the prompt.
      const { text, truncated } = readCapped(file.path, MAX_MEMORY_FILE_BYTES);
      body = text.trim();
      if (truncated) {
        body += "\n\n…[memory file truncated]";
      }
    } catch {
      // unreadable file — skip it
    }
    if (!body) continue;
    const block = `## Memory: ${file.name}\n\n${body}`;
    const blockBytes = Buffer.byteLength(block, "utf8");
    // Stop before the combined block exceeds the total cap (always keep at least
    // one so a single large file still contributes its capped slice).
    if (blocks.length > 0 && totalBytes + blockBytes > MAX_MEMORY_TOTAL_BYTES) {
      truncatedBlock = true;
      break;
    }
    blocks.push(block);
    totalBytes += blockBytes;
  }

  if (blocks.length === 0) return "";

  const footer = truncatedBlock
    ? `\n\n---\n\n…[project memory truncated: showing ${blocks.length} of ${files.length} files]`
    : "";

  return (
    "\n\n---\n# Project Memory\n\n" +
    "Notes you previously saved for this project. Use write_memory to persist " +
    "durable facts (conventions, decisions, gotchas) and keep them up to date.\n\n" +
    blocks.join("\n\n---\n\n") +
    footer
  );
}
