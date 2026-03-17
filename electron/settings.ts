import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface SettingsMap {
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_AUTH_TOKEN: string;
  ANTHROPIC_BASE_URL: string;
  ANTHROPIC_DEFAULT_SONNET_MODEL: string;
  ANTHROPIC_DEFAULT_HAIKU_MODEL: string;
  ANTHROPIC_DEFAULT_OPUS_MODEL: string;
  GITHUB_TOKEN: string;
  AICHEMIST_DEFAULT_PROVIDER: string;
  AICHEMIST_DEFAULT_APPROVAL_MODE: string;
}

const KNOWN_KEYS = new Set<string>([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "GITHUB_TOKEN",
  "AICHEMIST_DEFAULT_PROVIDER", "AICHEMIST_DEFAULT_APPROVAL_MODE",
]);

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
    AICHEMIST_DEFAULT_PROVIDER:      env["AICHEMIST_DEFAULT_PROVIDER"] ?? "anthropic",
    AICHEMIST_DEFAULT_APPROVAL_MODE: env["AICHEMIST_DEFAULT_APPROVAL_MODE"] ?? "custom",
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
