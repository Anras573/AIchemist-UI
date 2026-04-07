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

  const rel = path.relative(root, resolved);
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

// ── File-change capture helpers ───────────────────────────────────────────────

/** Returns true if a Buffer contains null bytes in its first 8 KB (binary heuristic). */
function isBinaryBuffer(buf: Buffer): boolean {
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
