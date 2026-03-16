import { tool } from "ai";
import { zodSchema } from "ai";
import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import type { ToolSet } from "ai";
import type { ProjectConfig } from "@/types";

// ── Return types mirroring Rust structs ──────────────────────────────────────

interface ReadFileResult {
  content: string;
  path: string;
  size_bytes: number;
}

interface WriteFileResult {
  path: string;
  bytes_written: number;
}

interface DeleteFileResult {
  path: string;
}

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size_bytes: number;
}

interface ListDirectoryResult {
  path: string;
  entries: DirEntry[];
}

interface ExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface WebFetchResult {
  url: string;
  status: number;
  body: string;
  content_type: string;
}

// ── Tool factory — returns tools respecting project's approval policy ─────────

/**
 * Build the tool set for an agent session.
 * Risky tools (write, delete, shell) respect the project's approval_mode:
 *   "all"    → every tool needs approval
 *   "none"   → no tool needs approval
 *   "custom" → check per-category approval_rules
 */
export function buildCoreTools(config: ProjectConfig): ToolSet {
  const needsApproval = makeApprovalChecker(config);

  return {
    read_file: tool({
      description:
        "Read the contents of a file at the given path. Returns the text content and file size.",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("Absolute or relative path to the file"),
        })
      ),
      execute: async ({ path }) =>
        invoke<ReadFileResult>("read_file", { path }),
    }),

    list_directory: tool({
      description:
        "List the files and subdirectories in a directory. Returns name, path, type, and size for each entry.",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("Absolute or relative path to the directory"),
        })
      ),
      execute: async ({ path }) =>
        invoke<ListDirectoryResult>("list_directory", { path }),
    }),

    write_file: tool({
      description:
        "Write text content to a file, creating parent directories as needed. Overwrites existing files.",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("Absolute or relative path to write to"),
          content: z.string().describe("Text content to write"),
        })
      ),
      needsApproval: needsApproval("filesystem"),
      execute: async ({ path, content }) =>
        invoke<WriteFileResult>("write_file", { path, content }),
    }),

    delete_file: tool({
      description: "Delete a single file. Cannot delete directories.",
      inputSchema: zodSchema(
        z.object({
          path: z.string().describe("Absolute or relative path to the file to delete"),
        })
      ),
      needsApproval: needsApproval("filesystem"),
      execute: async ({ path }) =>
        invoke<DeleteFileResult>("delete_file", { path }),
    }),

    execute_bash: tool({
      description:
        "Execute a shell command using /bin/sh. Returns stdout, stderr, and exit code. " +
        "Use the cwd parameter to set the working directory.",
      inputSchema: zodSchema(
        z.object({
          command: z.string().describe("Shell command to execute"),
          cwd: z
            .string()
            .optional()
            .describe("Working directory for the command"),
        })
      ),
      needsApproval: needsApproval("shell"),
      execute: async ({ command, cwd }) =>
        invoke<ExecResult>("execute_bash", { command, cwd: cwd ?? null }),
    }),

    web_fetch: tool({
      description:
        "Fetch the contents of a URL via HTTP GET. Returns the response body as text along with " +
        "the HTTP status code and content type. Use for reading documentation, APIs, or web pages.",
      inputSchema: zodSchema(
        z.object({
          url: z.string().url().describe("The URL to fetch"),
        })
      ),
      needsApproval: needsApproval("web"),
      execute: async ({ url }) =>
        invoke<WebFetchResult>("web_fetch", { url }),
    }),
  };
}

// ── Approval policy helper ────────────────────────────────────────────────────

type ToolCategory = "filesystem" | "shell" | "web";

function makeApprovalChecker(
  config: ProjectConfig
): (category: ToolCategory) => boolean {
  return (category) => {
    if (config.approval_mode === "all") return true;
    if (config.approval_mode === "none") return false;

    // "custom" mode — check per-category rules
    const rule = config.approval_rules.find(
      (r) => r.tool_category === category
    );
    if (!rule) return false; // default: no approval required
    return rule.policy === "always";
  };
}

/**
 * Core tools with no project config (no approval gates).
 * Used as a fallback when config is not yet available.
 */
export const coreTools: ToolSet = buildCoreTools({
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  approval_mode: "none",
  approval_rules: [],
  custom_tools: [],
});
