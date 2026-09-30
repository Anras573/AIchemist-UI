/**
 * Zod schema for a canvas definition's `canvas.json` manifest (#226). Shape
 * mirrors `CanvasDefinition` in `src/types/index.ts` (kept in sync by hand —
 * the type predates real validation, added by #221 so the store/discovery
 * consumers had something to reference before this module existed).
 *
 * `permissions` is declared intent only in v1: parsed and surfaced (e.g. in
 * a future trust prompt), never enforced — see the design doc's "OS-level
 * sandboxing (deferred)" section.
 */
import { z } from "zod";
import type { CanvasDefinition } from "../../src/types/index";

/**
 * Env-var names a declared secret may not use: they'd let a canvas's secret
 * override something that changes how the host process itself loads code.
 */
const RESERVED_SECRET_NAME = /^(PATH|HOME|USER|SHELL|TMPDIR|NODE_.*|ELECTRON_.*|LD_.*|DYLD_.*|BUN_.*)$/i;

export const CanvasSecretSchema = z.object({
  name: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "secret name must be a valid environment variable name")
    .refine((n) => !RESERVED_SECRET_NAME.test(n), { message: "secret name is reserved" }),
  description: z.string().optional(),
});

export const CanvasManifestSchema = z.object({
  name: z.string().min(1, "name must not be empty"),
  description: z.string().default(""),
  version: z.number().int().positive("version must be a positive integer"),
  /**
   * Path to the server module, relative to the definition folder. Runtime
   * resolution (`resolveCanvasServerPath` in `definitions.ts`) hardcodes
   * `server.mjs` rather than reading this field, so it's constrained to that
   * exact value — otherwise a manifest could validate and list as runnable
   * while pointing at a file the runtime will never actually look for,
   * failing later with an unexplained "canvas unavailable" (found in review
   * on #237). Revisit together if/when `definitions.ts` starts honoring a
   * custom path.
   */
  server: z.literal("server.mjs", { message: 'server must be "server.mjs" (the only path the runtime resolves)' }),
  /**
   * Path to the UI entry file, relative to the definition folder. Same
   * rationale as `server` above — `resolveCanvasUiDir` hardcodes the `ui/`
   * folder and the protocol always serves `index.html` from it, so this is
   * constrained to the one value that actually matches.
   */
  ui: z.literal("ui/index.html", { message: 'ui must be "ui/index.html" (the only path the runtime resolves)' }),
  attachByDefault: z.boolean().optional(),
  permissions: z
    .object({
      fs: z.array(z.string()).optional(),
      network: z.array(z.string()).optional(),
      exec: z.array(z.string()).optional(),
    })
    .optional(),
  /**
   * Credentials the canvas needs (#249). The user supplies each value per
   * definition; it's injected as an env var into this definition's host only.
   */
  secrets: z
    .array(CanvasSecretSchema)
    .refine((list) => new Set(list.map((x) => x.name)).size === list.length, { message: "secret names must be unique" })
    .optional(),
}) satisfies z.ZodType<CanvasDefinition, unknown>;

export type ParsedCanvasManifest = z.infer<typeof CanvasManifestSchema>;

export type CanvasManifestParseResult =
  | { success: true; manifest: CanvasDefinition }
  | { success: false; reason: string };

/**
 * Parses a `canvas.json` manifest already read into a JS value (the caller
 * handles the file read / `JSON.parse` itself, since discovery needs to
 * distinguish "file missing", "not JSON", and "fails validation" as
 * different logged reasons). Never throws.
 */
export function parseCanvasManifest(raw: unknown): CanvasManifestParseResult {
  const result = CanvasManifestSchema.safeParse(raw);
  if (result.success) return { success: true, manifest: result.data };
  const reason = result.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { success: false, reason };
}
