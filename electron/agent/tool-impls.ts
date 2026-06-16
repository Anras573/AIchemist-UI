import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";
import { createPatch } from "diff";
import type { FileChange } from "../../src/types/index";

// ── SDK-agnostic tool implementations ────────────────────────────────────────
//
// These functions contain the actual FS / shell / network logic for the four
// built-in tools. They return plain strings so they can be wrapped by any
// provider-specific tool registration API (MCP for Claude, defineTool for
// Copilot) without duplicating the implementation.

// ── Path validation ───────────────────────────────────────────────────────────

const MAX_WRITE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Sensitive sub-paths that must never be written to or deleted. */
const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.git(?:\/|$)/,
  /(?:^|\/)node_modules(?:\/|$)/,
  /(?:^|\/|^)\.env(\.|$)/,
];

/**
 * Resolves `inputPath` against `projectPath` and verifies the result stays
 * within the project root. Returns the resolved absolute path.
 *
 * Throws if the path escapes the project boundary or matches a sensitive
 * pattern (`.git`, `node_modules`, `.env*`).
 */
function resolveAndValidate(projectPath: string, inputPath: string): string {
  const root = path.resolve(projectPath);
  const resolved = path.resolve(root, inputPath);

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project boundary: "${inputPath}"`);
  }

  const rel = path.relative(root, resolved).replace(/\\/g, "/");
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(rel)) {
      throw new Error(`Access to sensitive path is not allowed: "${rel}"`);
    }
  }

  return resolved;
}

export async function implWriteFile(args: {
  path: string;
  content: string;
}): Promise<string> {
  try {
    fs.mkdirSync(path.dirname(args.path), { recursive: true });
    fs.writeFileSync(args.path, args.content, "utf8");
    return `File written: ${args.path}`;
  } catch (err) {
    return `Error writing file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function implDeleteFile(args: {
  path: string;
}): Promise<string> {
  try {
    fs.unlinkSync(args.path);
    return `File deleted: ${args.path}`;
  } catch (err) {
    return `Error deleting file: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function implExecuteBash(args: {
  command: string;
  cwd?: string;
  projectPath?: string;
}): Promise<string> {
  let cwd = args.cwd;
  if (cwd !== undefined && args.projectPath !== undefined) {
    try {
      cwd = resolveAndValidate(args.projectPath, cwd);
    } catch (err) {
      return JSON.stringify({
        stdout: "",
        stderr: `Error: ${err instanceof Error ? err.message : String(err)}`,
        exit_code: 1,
      });
    }
  }
  const proc = childProcess.spawnSync(args.command, {
    shell: true,
    cwd,
    encoding: "utf8",
  });
  return JSON.stringify({
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    exit_code: proc.status ?? -1,
  });
}

export async function implWebFetch(args: { url: string }): Promise<string> {
  try {
    const response = await fetch(args.url);
    const body = await response.text();
    return JSON.stringify({
      url: args.url,
      status: response.status,
      content_type: response.headers.get("content-type") ?? "",
      body,
    });
  } catch (err) {
    return `Error fetching URL: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Read-only FS tools (read_file / list_directory / glob) ───────────────────
//
// Shared by the history-replay providers (Ollama, OpenAI-compatible) whose
// tool loops run in-process. All paths are resolved against the project root
// with realpath-based boundary checks and sensitive-path filtering.

const MAX_READ_BYTES = 512 * 1024;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function resolveProjectPath(projectPath: string, inputPath: string): string {
  const root = fs.realpathSync(path.resolve(projectPath));
  const candidate = path.resolve(root, inputPath);
  const rel = path.relative(root, candidate).replace(/\\/g, "/");
  if (isSensitiveRelativePath(rel)) {
    throw new Error(`Access to sensitive path is not allowed: "${rel}"`);
  }
  const resolved = fs.realpathSync(candidate);
  const resolvedRel = path.relative(root, resolved).replace(/\\/g, "/");
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes project boundary: "${inputPath}"`);
  }
  if (isSensitiveRelativePath(resolvedRel)) {
    throw new Error(`Access to sensitive path is not allowed: "${resolvedRel}"`);
  }
  return resolved;
}

function isSensitiveRelativePath(relPath: string): boolean {
  return SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(relPath));
}

function shouldIgnoreDir(name: string): boolean {
  return [
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".turbo",
    "__pycache__",
    ".cache",
    ".parcel-cache",
    ".vite",
    "coverage",
    ".nyc_output",
  ].includes(name);
}

function globPatternToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === "*") {
      if (normalized[i + 1] === "*") {
        i++;
        if (normalized[i + 1] === "/") {
          i++;
          re += "(?:.*\\/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      re += "[^/]";
      continue;
    }
    re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re);
}

export function implReadTextFile(projectPath: string, inputPath: string): string {
  const resolved = resolveProjectPath(projectPath, inputPath);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a file: "${inputPath}"`);
  }
  if (stat.size > MAX_READ_BYTES) {
    throw new Error(`File too large (${Math.round(stat.size / 1024)} KB). Only files under 512 KB can be previewed.`);
  }
  const buf = fs.readFileSync(resolved);
  if (isBinaryBuffer(buf)) {
    return safeJson({
      path: resolved,
      is_binary: true,
      size_bytes: buf.length,
      content: "",
    });
  }
  return buf.toString("utf8");
}

export function implListDirectory(projectPath: string, inputPath: string): string {
  const resolved = resolveProjectPath(projectPath, inputPath || ".");
  const dirents = fs.readdirSync(resolved, { withFileTypes: true });
  const filtered = dirents.filter((d) => {
    const entryPath = path.join(resolved, d.name);
    const entryRel = path.relative(resolved, entryPath).replace(/\\/g, "/");
    return !shouldIgnoreDir(d.name) && !isSensitiveRelativePath(entryRel);
  });
  const truncated = filtered.length > 500;
  const visible = truncated ? filtered.slice(0, 500) : filtered;
  const entries = visible.map((dirent) => {
    const entryPath = path.join(resolved, dirent.name);
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
  return safeJson({ path: resolved, truncated, entries });
}

function walkGlob(
  root: string,
  cwd: string,
  pattern: RegExp,
  out: string[],
  limit: number,
): void {
  if (out.length >= limit) return;
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(cwd, { withFileTypes: true });
  } catch {
    return;
  }
  for (const dirent of dirents) {
    if (out.length >= limit) return;
    const abs = path.join(cwd, dirent.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (shouldIgnoreDir(dirent.name) || isSensitiveRelativePath(rel)) continue;
    if (dirent.isDirectory()) {
      walkGlob(root, abs, pattern, out, limit);
      continue;
    }
    if (pattern.test(rel) || pattern.test(path.basename(rel))) {
      out.push(abs);
    }
  }
}

export function implGlobFiles(projectPath: string, inputPattern: string): string {
  const pattern = inputPattern.trim();
  if (!pattern) return safeJson({ pattern, matches: [] as string[] });

  const root = fs.realpathSync(path.resolve(projectPath));
  const normalized = pattern.replace(/\\/g, "/");
  const regex = globPatternToRegExp(
    path.isAbsolute(normalized) ? path.relative(root, normalized).replace(/\\/g, "/") : normalized,
  );
  const matches: string[] = [];
  walkGlob(root, root, regex, matches, 200);
  return safeJson({ pattern, matches, truncated: matches.length >= 200 });
}

// ── File-change capture helpers ───────────────────────────────────────────────

/** Returns true if a Buffer contains null bytes in its first 8 KB (binary heuristic). */
export function isBinaryBuffer(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Wraps implWriteFile: validates the path is within the project boundary,
 * enforces a 10 MB size limit, reads before-content, calls the impl, then
 * returns both the result string and a FileChange (or null on write error).
 */
export async function implWriteFileWithChange(
  args: { path: string; content: string },
  projectPath: string
): Promise<{ result: string; change: FileChange | null }> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidate(projectPath, args.path);
  } catch (err) {
    return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, change: null };
  }

  if (Buffer.byteLength(args.content, "utf8") > MAX_WRITE_SIZE_BYTES) {
    return { result: "Error: File content exceeds the 10 MB size limit.", change: null };
  }

  const validatedArgs = { ...args, path: resolvedPath };

  let beforeBuf: Buffer | null = null;
  try {
    beforeBuf = fs.readFileSync(resolvedPath);
  } catch {
    // File doesn't exist yet — beforeBuf stays null
  }

  const result = await implWriteFile(validatedArgs);

  if (result.startsWith("Error")) return { result, change: null };

  const relPath = path.relative(projectPath, resolvedPath) || path.basename(resolvedPath);

  // Detect binary from before or after content
  let afterBuf: Buffer | null = null;
  try {
    afterBuf = fs.readFileSync(resolvedPath);
  } catch { /* ignore */ }

  if ((beforeBuf && isBinaryBuffer(beforeBuf)) || (afterBuf && isBinaryBuffer(afterBuf))) {
    return {
      result,
      change: { path: resolvedPath, relativePath: relPath, diff: "", operation: "write", isBinary: true },
    };
  }

  const before = beforeBuf ? beforeBuf.toString("utf8") : "";
  const diff = createPatch(relPath, before, args.content, "", "");

  return {
    result,
    change: { path: resolvedPath, relativePath: relPath, diff, operation: "write" },
  };
}

/**
 * Wraps implDeleteFile: validates the path is within the project boundary,
 * reads before-content, calls the impl, then returns both the result string
 * and a FileChange (or null on delete error).
 */
export async function implDeleteFileWithChange(
  args: { path: string },
  projectPath: string
): Promise<{ result: string; change: FileChange | null }> {
  let resolvedPath: string;
  try {
    resolvedPath = resolveAndValidate(projectPath, args.path);
  } catch (err) {
    return { result: `Error: ${err instanceof Error ? err.message : String(err)}`, change: null };
  }

  const validatedArgs = { ...args, path: resolvedPath };

  let beforeBuf: Buffer | null = null;
  try {
    beforeBuf = fs.readFileSync(resolvedPath);
  } catch {
    beforeBuf = null;
  }

  const result = await implDeleteFile(validatedArgs);

  if (result.startsWith("Error")) return { result, change: null };

  const relPath = path.relative(projectPath, resolvedPath) || path.basename(resolvedPath);

  if (beforeBuf && isBinaryBuffer(beforeBuf)) {
    return {
      result,
      change: { path: resolvedPath, relativePath: relPath, diff: "", operation: "delete", isBinary: true },
    };
  }

  const before = beforeBuf ? beforeBuf.toString("utf8") : "";
  const diff = createPatch(relPath, before, "", "", "");

  return {
    result,
    change: { path: resolvedPath, relativePath: relPath, diff, operation: "delete" },
  };
}
