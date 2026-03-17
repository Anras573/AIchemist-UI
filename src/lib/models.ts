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

  // For dynamic Copilot models or other unknown IDs, produce a tidy label
  return modelId
    .replace(/-(\d)/g, " $1")   // dash before number → space (gpt-4o → gpt 4o)
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/** Logo provider string for use with ModelSelectorLogo. */
export function getLogoProvider(provider: string): string {
  if (provider === "copilot") return "github-copilot";
  return provider; // "anthropic" passes through as-is
}
