/**
 * Per-canvas declared secrets (#249).
 *
 * A manifest's `secrets` lists the credentials a canvas needs; the user
 * supplies each value, stored here in `~/.aichemist/canvas-secrets.json`
 * (mode 0600, like `openai-providers.json`) — never in `canvases.state`, the
 * DB, logs, or `CANVAS_EVENT` payloads. Values are injected as env vars into
 * that definition's host only (`StartCanvasHostOptions.resolveEnv`); the
 * renderer only ever sees whether a value is set.
 *
 * Scope: a global/built-in definition is keyed by its name; a project-tier
 * one by `project:<projectId>:<name>`, so a cloned repo's canvas can't claim a
 * secret the user gave a same-named global canvas.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { CanvasDefinition, CanvasSecretStatus } from "../../src/types/index";
import { discoverCanvasDefinitions } from "./discovery";

type SecretsFile = Record<string, Record<string, string>>;

let pathOverride: string | null = null;

/** Test seam — override the secrets file location. Pass null to reset. */
export function _setCanvasSecretsPathForTests(p: string | null): void {
  pathOverride = p;
}

export function getCanvasSecretsPath(): string {
  return pathOverride ?? path.join(os.homedir(), ".aichemist", "canvas-secrets.json");
}

export function secretScopeKey(tier: "project" | "global" | "builtin", definition: string, projectId: string): string {
  return tier === "project" ? `project:${projectId}:${definition}` : definition;
}

function readAll(): SecretsFile {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(getCanvasSecretsPath(), "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SecretsFile = {};
    for (const [scope, values] of Object.entries(parsed as Record<string, unknown>)) {
      if (!values || typeof values !== "object" || Array.isArray(values)) continue;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (typeof v === "string") clean[k] = v;
      }
      out[scope] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(data: SecretsFile): void {
  const file = getCanvasSecretsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Sets one secret. The name must be declared by the caller-supplied manifest. */
export function setCanvasSecret(scope: string, declared: CanvasDefinition["secrets"], name: string, value: string): void {
  if (!declared?.some((s) => s.name === name)) throw new Error(`Secret "${name}" is not declared by this canvas`);
  const all = readAll();
  all[scope] = { ...all[scope], [name]: value };
  writeAll(all);
}

export function clearCanvasSecret(scope: string, name: string): void {
  const all = readAll();
  if (!all[scope] || !(name in all[scope])) return;
  delete all[scope][name];
  if (Object.keys(all[scope]).length === 0) delete all[scope];
  writeAll(all);
}

/** Declared secrets + whether each has a value. Values never leave this module except via {@link resolveSecretEnv}. */
export function getCanvasSecretStatus(scope: string, declared: CanvasDefinition["secrets"]): CanvasSecretStatus[] {
  const stored = readAll()[scope] ?? {};
  return (declared ?? []).map((s) => ({ ...s, set: typeof stored[s.name] === "string" && stored[s.name] !== "" }));
}

/** Env vars for a host: ONLY the declared names that have a value. */
export function resolveSecretEnv(scope: string, declared: CanvasDefinition["secrets"]): Record<string, string> {
  const stored = readAll()[scope] ?? {};
  const env: Record<string, string> = {};
  for (const s of declared ?? []) {
    const v = stored[s.name];
    if (typeof v === "string" && v !== "") env[s.name] = v;
  }
  return env;
}

/**
 * Finds the definition a canvas instance runs (same runnable-tier-first
 * preference as spawn-time resolution) and returns its secrets scope and
 * declared list, or null when the definition can't be found.
 */
export function resolveCanvasSecretScope(
  projectId: string,
  projectPath: string,
  definition: string
): { scope: string; declared: CanvasDefinition["secrets"] } | null {
  const { definitions } = discoverCanvasDefinitions(projectPath);
  const matches = definitions.filter((d) => d.id === definition);
  const entry = matches.find((d) => d.tier !== "project") ?? matches[0];
  if (!entry) return null;
  return { scope: secretScopeKey(entry.tier, definition, projectId), declared: entry.manifest.secrets };
}

/** Spawn-time env for a canvas instance's host. Empty when nothing is declared or set. */
export function resolveCanvasSecretEnv(projectId: string, projectPath: string, definition: string): Record<string, string> {
  const r = resolveCanvasSecretScope(projectId, projectPath, definition);
  return r ? resolveSecretEnv(r.scope, r.declared) : {};
}
