import { createRequire } from "node:module";
import * as nodePath from "node:path";
import * as fs from "node:fs";

// ─────────────────────────────────────────────────────────────────────────────
// Codex CLI binary resolution.
//
// The `codex app-server` transport (#128) spawns the Codex binary directly, so
// it needs the same bundled binary the SDK's exec path resolves internally. The
// SDK does not export its resolver (`findCodexPath`), so we mirror it here: map
// platform/arch → target triple → the `@openai/codex-<platform>` vendor dir.
// This relies on the SAME node_modules layout the exec path already depends on,
// so it introduces no new packaging requirement. `CODEX_CLI_PATH` overrides
// everything (matches the SDK's `codexPathOverride`); an unresolvable binary
// returns null so the caller can fall back (ultimately to the exec transport).
//
// Layout (per platform package): <pkg>/vendor/<triple>/bin/codex  (+ a
// codex-package.json marker) with sibling tool dirs under <triple>/codex-path
// that must be prepended to the child PATH; a legacy layout nests under
// <triple>/codex/ with a `path` dir.
// ─────────────────────────────────────────────────────────────────────────────

const CODEX_NPM_NAME = "@openai/codex";

const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  "x86_64-unknown-linux-musl": "@openai/codex-linux-x64",
  "aarch64-unknown-linux-musl": "@openai/codex-linux-arm64",
  "x86_64-apple-darwin": "@openai/codex-darwin-x64",
  "aarch64-apple-darwin": "@openai/codex-darwin-arm64",
  "x86_64-pc-windows-msvc": "@openai/codex-win32-x64",
  "aarch64-pc-windows-msvc": "@openai/codex-win32-arm64",
};

export interface ResolvedCodexBinary {
  executablePath: string;
  /** Sibling tool dirs to prepend to the child process PATH (may be empty). */
  pathDirs: string[];
}

/** Map a Node platform/arch to Codex's Rust target triple, or null if unsupported. */
export function codexTargetTriple(platform: NodeJS.Platform, arch: string): string | null {
  switch (platform) {
    case "linux":
    case "android":
      if (arch === "x64") return "x86_64-unknown-linux-musl";
      if (arch === "arm64") return "aarch64-unknown-linux-musl";
      return null;
    case "darwin":
      if (arch === "x64") return "x86_64-apple-darwin";
      if (arch === "arm64") return "aarch64-apple-darwin";
      return null;
    case "win32":
      if (arch === "x64") return "x86_64-pc-windows-msvc";
      if (arch === "arm64") return "aarch64-pc-windows-msvc";
      return null;
    default:
      return null;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function existingDirs(...dirs: string[]): string[] {
  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * A `require` anchored at a real file so `require.resolve` walks the app's
 * node_modules. Uses this module's path in the CJS Electron build; falls back to
 * cwd in ESM/test contexts where `__filename` isn't defined (`typeof` on an
 * undeclared identifier is safe — it yields "undefined" without throwing).
 */
function anchoredRequire(): NodeRequire {
  const anchor =
    typeof __filename !== "undefined" ? __filename : nodePath.join(process.cwd(), "noop.js");
  return createRequire(anchor);
}

/**
 * Resolve the bundled Codex binary + any sibling tool dirs. Returns null when it
 * can't be located (unsupported platform, missing optional dependency), so the
 * caller falls back. `CODEX_CLI_PATH` takes precedence over the bundled binary.
 */
export function resolveCodexBinary(): ResolvedCodexBinary | null {
  const override = process.env.CODEX_CLI_PATH?.trim();
  if (override) return { executablePath: override, pathDirs: [] };

  const triple = codexTargetTriple(process.platform, process.arch);
  if (!triple) return null;
  const platformPackage = PLATFORM_PACKAGE_BY_TARGET[triple];
  if (!platformPackage) return null;

  try {
    const req = anchoredRequire();
    const codexPackageJson = req.resolve(`${CODEX_NPM_NAME}/package.json`);
    const codexRequire = createRequire(codexPackageJson);
    const platformPackageJson = codexRequire.resolve(`${platformPackage}/package.json`);
    const vendorRoot = nodePath.join(nodePath.dirname(platformPackageJson), "vendor");
    const packageRoot = nodePath.join(vendorRoot, triple);
    const binaryName = process.platform === "win32" ? "codex.exe" : "codex";

    const binaryPath = nodePath.join(packageRoot, "bin", binaryName);
    if (isFile(binaryPath) && isFile(nodePath.join(packageRoot, "codex-package.json"))) {
      return { executablePath: binaryPath, pathDirs: existingDirs(nodePath.join(packageRoot, "codex-path")) };
    }
    const legacyPath = nodePath.join(packageRoot, "codex", binaryName);
    if (isFile(legacyPath)) {
      return { executablePath: legacyPath, pathDirs: existingDirs(nodePath.join(packageRoot, "path")) };
    }
    return null;
  } catch {
    return null;
  }
}
