/**
 * Static model catalogue — shared between ModelPickerButton and SessionTabBar.
 * Copilot models are fetched dynamically at runtime; this list only covers
 * the statically known Anthropic models.
 */

export interface ModelOption {
  provider: string;
  model: string;
  label: string;
  logoProvider: string;
}

export const ANTHROPIC_MODELS: ModelOption[] = [
  { provider: "anthropic", model: "claude-opus-4-6",           label: "Claude Opus 4.6",   logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-sonnet-4-6",         label: "Claude Sonnet 4.6", logoProvider: "anthropic" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5",  logoProvider: "anthropic" },
];

/**
 * Returns a human-readable label for a provider + model ID pair.
 * Falls back to a cleaned-up version of the model ID for unknown models.
 */
export function getModelLabel(provider: string, modelId: string): string {
  const known = ANTHROPIC_MODELS.find(
    (m) => m.provider === provider && m.model === modelId
  );
  if (known) return known.label;

  // OpenAI-like model ids are often composite IDs — keep them verbatim.
  if (provider === "openai-compatible" || provider === "codex") return modelId;

  // For dynamic Copilot models or other unknown IDs, produce a tidy label
  return modelId
    .replace(/-(\d)/g, " $1")   // dash before number → space (gpt-4o → gpt 4o)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Logo provider string for use with ModelSelectorLogo. */
export { getProviderLogo as getLogoProvider } from "@/lib/providers";

/** Known context window sizes (in tokens) by model ID substring or exact match. */
const MODEL_CONTEXT_WINDOWS: Array<[string, number]> = [
  // Anthropic — all current models have 200K
  ["claude-", 200_000],
  // OpenAI
  ["gpt-4o-mini", 128_000],
  ["gpt-4o", 128_000],
  ["gpt-4", 128_000],
  ["o1-mini", 128_000],
  ["o1-preview", 128_000],
  ["o1", 200_000],
  ["o3-mini", 200_000],
  ["o3", 200_000],
  // Google
  ["gemini-2.0-flash", 1_000_000],
  ["gemini-1.5-pro", 2_000_000],
  ["gemini-1.5-flash", 1_000_000],
];

/** Returns the context window size in tokens for a known model, or null if unknown. */
export function getModelContextWindow(modelId: string): number | null {
  const lower = modelId.trim().toLowerCase();
  for (const [substr, size] of MODEL_CONTEXT_WINDOWS) {
    if (lower.includes(substr.toLowerCase())) return size;
  }
  return null;
}
