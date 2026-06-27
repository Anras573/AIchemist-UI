import * as fs from "fs";
import * as os from "os";
import * as path from "path";
export { parseDisabledProviders } from "./providers";

export interface SettingsMap {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  GITHUB_TOKEN: string;
  /** OpenAI key used by the Codex provider. Resolved via getApiKey("openai"). */
  OPENAI_API_KEY: string;
  AICHEMIST_DEFAULT_PROVIDER: string;
  AICHEMIST_DEFAULT_APPROVAL_MODE: string;
  AICHEMIST_THEME: string;
  /**
   * Comma-separated list of providers the user has explicitly disabled
   * app-wide. Values: any of the ids in PROVIDER_IDS (electron/providers.ts).
   * Empty string means none disabled. The probe handler treats these as
   * `{ ok: false, reason: "Disabled in settings" }` without running the
   * actual probe, so the new-session UI greys them out everywhere.
   */
  AICHEMIST_DISABLED_PROVIDERS: string;
  /**
   * Maximum number of in-process tool rounds for the self-driven providers
   * (Ollama / OpenAI-compatible) before the turn is stopped. Stored as a
   * string; parse with {@link parseMaxToolRounds}. Empty string means "use the
   * default" ({@link DEFAULT_MAX_TOOL_ROUNDS}). The SDK-backed providers
   * (Claude, Copilot) are bounded by the context window and ignore this.
   */
  AICHEMIST_MAX_TOOL_ROUNDS: string;
}

const KNOWN_KEYS = new Set<string>([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "GITHUB_TOKEN", "OPENAI_API_KEY",
  "AICHEMIST_DEFAULT_PROVIDER", "AICHEMIST_DEFAULT_APPROVAL_MODE",
  "AICHEMIST_THEME",
  "AICHEMIST_DISABLED_PROVIDERS",
  "AICHEMIST_MAX_TOOL_ROUNDS",
]);

/** Default tool-round cap for self-driven providers when unset / invalid. */
export const DEFAULT_MAX_TOOL_ROUNDS = 8;
/** Lower bound — at least one round so the model can run once. */
export const MIN_MAX_TOOL_ROUNDS = 1;
/** Upper bound — guard against runaway loops from a fat-fingered value. */
export const MAX_MAX_TOOL_ROUNDS = 100;

/**
 * Parse and clamp the configured tool-round cap. Falls back to
 * {@link DEFAULT_MAX_TOOL_ROUNDS} for empty / non-numeric input and clamps to
 * [{@link MIN_MAX_TOOL_ROUNDS}, {@link MAX_MAX_TOOL_ROUNDS}].
 */
export function parseMaxToolRounds(raw: string | undefined): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_TOOL_ROUNDS;
  return Math.min(MAX_MAX_TOOL_ROUNDS, Math.max(MIN_MAX_TOOL_ROUNDS, n));
}

/** Resolve the effective tool-round cap from persisted settings. */
export function readMaxToolRounds(): number {
  return parseMaxToolRounds(readSettings().AICHEMIST_MAX_TOOL_ROUNDS);
}

function envPath(): string {
  return path.join(os.homedir(), ".aichemist", ".env");
}

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const raw = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    result[key] = raw.replace(/^["']|["']$/g, "");
  }
  return result;
}

export function readSettings(): SettingsMap {
  let content = "";
  try { content = fs.readFileSync(envPath(), "utf-8"); } catch { /* file may not exist yet */ }
  const env = parseEnv(content);
  return {
    ANTHROPIC_API_KEY:               env["ANTHROPIC_API_KEY"] ?? "",
    ANTHROPIC_AUTH_TOKEN:            env["ANTHROPIC_AUTH_TOKEN"] ?? "",
    ANTHROPIC_BASE_URL:              env["ANTHROPIC_BASE_URL"] ?? "",
    ANTHROPIC_DEFAULT_SONNET_MODEL:  env["ANTHROPIC_DEFAULT_SONNET_MODEL"] ?? "",
    ANTHROPIC_DEFAULT_HAIKU_MODEL:   env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] ?? "",
    ANTHROPIC_DEFAULT_OPUS_MODEL:    env["ANTHROPIC_DEFAULT_OPUS_MODEL"] ?? "",
    GITHUB_TOKEN:                    env["GITHUB_TOKEN"] ?? "",
    OPENAI_API_KEY:                  env["OPENAI_API_KEY"] ?? "",
    AICHEMIST_DEFAULT_PROVIDER:      env["AICHEMIST_DEFAULT_PROVIDER"] ?? "anthropic",
    AICHEMIST_DEFAULT_APPROVAL_MODE: env["AICHEMIST_DEFAULT_APPROVAL_MODE"] ?? "custom",
    AICHEMIST_THEME:                 env["AICHEMIST_THEME"] ?? "system",
    AICHEMIST_DISABLED_PROVIDERS:    env["AICHEMIST_DISABLED_PROVIDERS"] ?? "",
    AICHEMIST_MAX_TOOL_ROUNDS:       env["AICHEMIST_MAX_TOOL_ROUNDS"] ?? "",
  };
}

export function writeSettings(updates: Partial<SettingsMap>): void {
  const p = envPath();
  let lines: string[] = [];
  try { lines = fs.readFileSync(p, "utf-8").split("\n"); } catch { /* new file */ }

  // Track which keys we've already updated in existing lines
  const updated = new Set<string>();

  const newLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) return line;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key in updates) {
      updated.add(key);
      const val = (updates as Record<string, string>)[key];
      return val ? `${key}=${val}` : `# ${key}=`;
    }
    return line;
  });

  // Append any keys not yet in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!updated.has(key) && KNOWN_KEYS.has(key) && val) {
      newLines.push(`${key}=${val}`);
    }
  }

  // Ensure the directory exists
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, newLines.join("\n"), "utf-8");

  // Apply to live process.env so changes take effect without restart
  for (const [key, val] of Object.entries(updates)) {
    if (val) process.env[key] = val;
    else delete process.env[key];
  }
}
