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

export const CanvasManifestSchema = z.object({
  name: z.string().min(1, "name must not be empty"),
  description: z.string().default(""),
  version: z.number().int().positive("version must be a positive integer"),
  /** Path to the server module, relative to the definition folder. */
  server: z.string().min(1, "server must not be empty"),
  /** Path to the UI entry file, relative to the definition folder. */
  ui: z.string().min(1, "ui must not be empty"),
  attachByDefault: z.boolean().optional(),
  permissions: z
    .object({
      fs: z.array(z.string()).optional(),
      network: z.array(z.string()).optional(),
      exec: z.array(z.string()).optional(),
    })
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
