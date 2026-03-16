import * as dotenv from "dotenv";
import * as os from "os";
import * as path from "path";
import { execSync } from "child_process";

/**
 * Load ~/.aichemist/.env into process.env.
 * Call once at app start; subsequent calls are no-ops (dotenv skips existing vars).
 */
export function loadEnv(): void {
  const envPath = path.join(os.homedir(), ".aichemist", ".env");
  dotenv.config({ path: envPath });

  // Electron on macOS doesn't inherit the user's shell PATH (no /opt/homebrew/bin etc.).
  // Augment PATH here so child_process spawns (e.g. the claude CLI) can be found.
  augmentPath();
}

/**
 * Attempt to resolve the absolute path to the `claude` CLI.
 * Returns null if not found.
 */
export function resolveClaudePath(): string | null {
  // Explicit override wins
  const override = process.env.CLAUDE_CODE_PATH;
  if (override) return override;

  // Check common locations before falling back to `which`
  const candidates = [
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    `${os.homedir()}/.npm-global/bin/claude`,
    `${os.homedir()}/.local/bin/claude`,
  ];
  for (const p of candidates) {
    try {
      const { statSync } = require("fs") as typeof import("fs");
      statSync(p);
      return p;
    } catch { /* not found */ }
  }

  // Last resort: ask the shell
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

/** Augment process.env.PATH with common macOS binary dirs if missing. */
function augmentPath(): void {
  const extras = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
  ];
  const current = process.env.PATH ?? "";
  const parts = current.split(":");
  for (const dir of extras) {
    if (!parts.includes(dir)) parts.unshift(dir);
  }
  process.env.PATH = parts.join(":");
}

/**
 * Resolve an API key for the given provider.
 *
 * Resolution order mirrors config.rs:
 *   1. Process environment (already set on OS launch or by loadEnv())
 *   2. Returns null → renderer shows "configure API key" prompt
 */
export function getApiKey(provider: string): string | null {
  const nonEmpty = (s: string | undefined): string | null =>
    s && s.length > 0 ? s : null;

  let value: string | null = null;

  switch (provider.toLowerCase()) {
    case "anthropic":
      value =
        nonEmpty(process.env.ANTHROPIC_API_KEY) ??
        nonEmpty(process.env.ANTHROPIC_AUTH_TOKEN);
      break;
    case "openai":
      value = nonEmpty(process.env.OPENAI_API_KEY);
      break;
    case "ollama":
      return null;
    case "github":
    case "copilot":
      value = nonEmpty(process.env.GITHUB_TOKEN);
      break;
    default:
      value = nonEmpty(process.env[`${provider.toUpperCase()}_API_KEY`]);
  }

  return value;
}

/** Anthropic-specific config resolved from the environment. Mirrors config.rs. */
export function getAnthropicConfig(): {
  api_key: string | null;
  base_url: string | null;
  default_sonnet_model: string | null;
  default_haiku_model: string | null;
  default_opus_model: string | null;
} {
  const nonEmpty = (s: string | undefined): string | null =>
    s && s.length > 0 ? s : null;

  const api_key =
    nonEmpty(process.env.ANTHROPIC_API_KEY) ??
    nonEmpty(process.env.ANTHROPIC_AUTH_TOKEN);

  return {
    api_key,
    base_url: nonEmpty(process.env.ANTHROPIC_BASE_URL),
    default_sonnet_model: nonEmpty(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL),
    default_haiku_model: nonEmpty(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
    default_opus_model: nonEmpty(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL),
  };
}
