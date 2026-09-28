/**
 * Canvas definition discovery (#226) — mirrors `skills-discovery.ts`: scans
 * the three tiers in priority order (project → global → built-in), reads and
 * validates each `canvas.json`, and suppresses a lower tier's definition when
 * a higher tier already claims the same folder name. A manifest that fails to
 * read or validate is skipped and reported as a `CanvasManifestError` rather
 * than breaking discovery for the rest.
 *
 * This is a *listing* concern, separate from `definitions.ts`'s path
 * resolution (`resolveCanvasServerPath` / `resolveCanvasUiDir`), which
 * deliberately never resolves the project tier — untrusted until the trust
 * model (a later issue) lands. A project-tier definition is discovered and
 * listed here so the settings hub can show it, but it stays unrunnable
 * because resolution never looks there; "list but don't start" falls out of
 * that split for free, with no extra gating needed in this module.
 */
import * as fs from "node:fs";
import * as nodePath from "node:path";
import type {
  CanvasDefinitionEntry,
  CanvasDefinitionTier,
  CanvasDiscoveryResult,
  CanvasManifestError,
} from "../../src/types/index";
import { builtinCanvasesRoot, canvasesRoot, isSafeDefinitionName } from "./definitions";
import { parseCanvasManifest } from "./manifest";

interface TierScanResult {
  entries: CanvasDefinitionEntry[];
  errors: CanvasManifestError[];
}

/** Scans one tier's root directory for `<name>/canvas.json` folders. Missing root = no entries, no error. */
function scanTier(root: string, tier: CanvasDefinitionTier): TierScanResult {
  const entries: CanvasDefinitionEntry[] = [];
  const errors: CanvasManifestError[] = [];

  let dirEntries: fs.Dirent[];
  try {
    dirEntries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { entries, errors };
  }

  for (const dirEntry of dirEntries) {
    if (!dirEntry.isDirectory()) continue;
    if (!isSafeDefinitionName(dirEntry.name)) continue;

    const defPath = nodePath.join(root, dirEntry.name);
    const manifestPath = nodePath.join(defPath, "canvas.json");

    let raw: string;
    try {
      raw = fs.readFileSync(manifestPath, "utf8");
    } catch (err) {
      errors.push({
        id: dirEntry.name,
        tier,
        path: defPath,
        reason: `canvas.json could not be read: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      errors.push({
        id: dirEntry.name,
        tier,
        path: defPath,
        reason: `canvas.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const result = parseCanvasManifest(parsed);
    if (!result.success) {
      errors.push({ id: dirEntry.name, tier, path: defPath, reason: result.reason });
      continue;
    }

    entries.push({ id: dirEntry.name, tier, manifest: result.manifest, path: defPath });
  }

  return { entries, errors };
}

/**
 * Discovers canvas definitions across all three tiers. `projectPath` is
 * optional — omitted (e.g. no active project, or a headless caller) simply
 * skips the project tier rather than erroring.
 *
 * The project tier is deliberately excluded from suppression (found in
 * review on #237): a project definition is untrusted and never actually
 * runs (`resolveCanvasServerPath`/`resolveCanvasUiDir` never resolve it), so
 * it must never hide a same-named global/built-in one that *would* run — a
 * cloned repo shipping a bare `.agents/canvases/kanban/canvas.json` must not
 * be able to make the real, runnable `kanban` disappear from the picker.
 * Project entries are always included as-is; suppression (higher tier wins)
 * only applies among global/built-in, same as before.
 */
export function discoverCanvasDefinitions(projectPath?: string): CanvasDiscoveryResult {
  const definitions: CanvasDefinitionEntry[] = [];
  const errors: CanvasManifestError[] = [];

  if (projectPath) {
    const { entries, errors: tierErrors } = scanTier(
      nodePath.join(projectPath, ".agents", "canvases"),
      "project"
    );
    definitions.push(...entries);
    errors.push(...tierErrors);
  }

  const runnableTiers: Array<{ root: string; tier: CanvasDefinitionTier }> = [
    { root: canvasesRoot(), tier: "global" },
    { root: builtinCanvasesRoot(), tier: "builtin" },
  ];

  const seen = new Set<string>();
  for (const { root, tier } of runnableTiers) {
    const { entries, errors: tierErrors } = scanTier(root, tier);
    errors.push(...tierErrors);
    for (const entry of entries) {
      if (seen.has(entry.id)) continue; // suppressed by a higher (runnable) tier
      seen.add(entry.id);
      definitions.push(entry);
    }
  }

  return { definitions, errors };
}
