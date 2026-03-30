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
}): Promise<string> {
  const proc = childProcess.spawnSync(args.command, {
    shell: true,
    cwd: args.cwd,
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
 * Wraps implWriteFile: reads before-content, calls the impl, then returns
 * both the result string and a FileChange (or null on write error).
 */
export async function implWriteFileWithChange(
  args: { path: string; content: string },
  projectPath: string
): Promise<{ result: string; change: FileChange | null }> {
  let beforeBuf: Buffer | null = null;
  try {
    beforeBuf = fs.readFileSync(args.path);
  } catch {
    // File doesn't exist yet — beforeBuf stays null
  }

  const result = await implWriteFile(args);

  if (result.startsWith("Error")) return { result, change: null };

  const relPath = path.relative(projectPath, args.path) || path.basename(args.path);

  // Detect binary from before or after content
  let afterBuf: Buffer | null = null;
  try {
    afterBuf = fs.readFileSync(args.path);
  } catch { /* ignore */ }

  if ((beforeBuf && isBinaryBuffer(beforeBuf)) || (afterBuf && isBinaryBuffer(afterBuf))) {
    return {
      result,
      change: { path: args.path, relativePath: relPath, diff: "", operation: "write", isBinary: true },
    };
  }

  const before = beforeBuf ? beforeBuf.toString("utf8") : "";
  const diff = createPatch(relPath, before, args.content, "", "");

  return {
    result,
    change: { path: args.path, relativePath: relPath, diff, operation: "write" },
  };
}

/**
 * Wraps implDeleteFile: reads before-content, calls the impl, then returns
 * both the result string and a FileChange (or null on delete error).
 */
export async function implDeleteFileWithChange(
  args: { path: string },
  projectPath: string
): Promise<{ result: string; change: FileChange | null }> {
  let beforeBuf: Buffer | null = null;
  try {
    beforeBuf = fs.readFileSync(args.path);
  } catch {
    beforeBuf = null;
  }

  const result = await implDeleteFile(args);

  if (result.startsWith("Error")) return { result, change: null };

  const relPath = path.relative(projectPath, args.path) || path.basename(args.path);

  if (beforeBuf && isBinaryBuffer(beforeBuf)) {
    return {
      result,
      change: { path: args.path, relativePath: relPath, diff: "", operation: "delete", isBinary: true },
    };
  }

  const before = beforeBuf ? beforeBuf.toString("utf8") : "";
  const diff = createPatch(relPath, before, "", "", "");

  return {
    result,
    change: { path: args.path, relativePath: relPath, diff, operation: "delete" },
  };
}
