import * as fs from "fs";
import * as path from "path";
import * as childProcess from "child_process";

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
