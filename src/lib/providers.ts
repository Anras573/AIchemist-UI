/**
 * Renderer-side provider display metadata.
 *
 * The canonical provider id list lives in electron/providers.ts (safe to
 * import from the renderer — pure constants). This module adds the short
 * labels and models.dev logo ids the session UI uses, so components iterate
 * one list instead of hardcoding provider unions.
 */
import { PROVIDER_IDS } from "../../electron/providers";
import type { Provider } from "@/types";

/** All providers, in canonical order. */
export const PROVIDERS: readonly Provider[] = PROVIDER_IDS;

/** Short labels for compact UI (radios, menu items). */
export const PROVIDER_SHORT_LABELS: Record<Provider, string> = {
  anthropic: "Claude",
  copilot: "Copilot",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible",
};

/** models.dev logo id for ModelSelectorLogo. */
export function getProviderLogo(provider: string): string {
  if (provider === "copilot") return "github-copilot";
  if (provider === "openai-compatible") return "openai";
  return provider;
}

export function isProvider(value: string | null | undefined): value is Provider {
  return (PROVIDER_IDS as readonly string[]).includes(value ?? "");
}
