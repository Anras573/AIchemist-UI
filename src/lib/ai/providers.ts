import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { invoke } from "@tauri-apps/api/core";
import type { LanguageModel } from "ai";
import type { ProjectConfig } from "@/types";

interface AnthropicConfig {
  api_key: string | null;
  base_url: string | null;
  default_sonnet_model: string | null;
  default_haiku_model: string | null;
  default_opus_model: string | null;
}

/**
 * Resolve the actual Anthropic model ID to use, applying any
 * ANTHROPIC_DEFAULT_*_MODEL env var overrides — same logic as Claude Code.
 *
 * Only overrides when the project model matches the relevant model family
 * (sonnet, haiku, or opus). If the user has explicitly chosen a model that
 * doesn't match any family, we pass it through unchanged.
 */
function resolveAnthropicModel(
  requestedModel: string,
  config: AnthropicConfig
): string {
  if (config.default_sonnet_model && requestedModel.includes("sonnet")) {
    return config.default_sonnet_model;
  }
  if (config.default_haiku_model && requestedModel.includes("haiku")) {
    return config.default_haiku_model;
  }
  if (config.default_opus_model && requestedModel.includes("opus")) {
    return config.default_opus_model;
  }
  return requestedModel;
}

/**
 * Build a LanguageModel for the given project config.
 * Fetches provider-specific configuration from Rust (env var resolution)
 * then constructs the appropriate provider client.
 */
export async function buildModel(config: ProjectConfig): Promise<LanguageModel> {
  switch (config.provider) {
    case "anthropic": {
      const anthropicConfig = await invoke<AnthropicConfig>("get_anthropic_config");

      if (!anthropicConfig.api_key) {
        throw new Error(
          "Anthropic API key is not set. Add ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN to ~/.aichemist/.env"
        );
      }

      const modelId = resolveAnthropicModel(config.model, anthropicConfig);

      return createAnthropic({
        apiKey: anthropicConfig.api_key,
        ...(anthropicConfig.base_url ? { baseURL: anthropicConfig.base_url, headers: { "api-key": anthropicConfig.api_key } } : {}),
      })(modelId);
    }

    case "openai": {
      const apiKey = await invoke<string | null>("get_api_key", { provider: "openai" });
      if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Add it to ~/.aichemist/.env");
      return createOpenAI({ apiKey })(config.model);
    }

    case "ollama": {
      return createOpenAICompatible({
        name: "ollama",
        baseURL: "http://localhost:11434/v1",
      })(config.model);
    }

    default: {
      const apiKey = await invoke<string | null>("get_api_key", { provider: config.provider });
      if (!apiKey) throw new Error(`API key for "${config.provider}" is not set`);
      return createOpenAICompatible({
        name: config.provider,
        baseURL: "http://localhost:11434/v1",
        apiKey,
      })(config.model);
    }
  }
}
