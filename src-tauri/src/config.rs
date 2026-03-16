/// Resolve an API key for the given provider.
///
/// Resolution order:
///   1. Process environment (loaded from the OS on app launch)
///   2. ~/.aichemist/.env loaded by dotenvy in lib.rs::run()
///   3. Returns None → frontend shows "configure API key" prompt
#[tauri::command]
pub fn get_api_key(provider: String) -> Option<String> {
    let key = match provider.as_str() {
        "anthropic" => std::env::var("ANTHROPIC_API_KEY")
            .ok()
            .or_else(|| std::env::var("ANTHROPIC_AUTH_TOKEN").ok()),
        "openai" => std::env::var("OPENAI_API_KEY").ok(),
        // Ollama is local — no key needed
        "ollama" => return None,
        // Custom provider: try the uppercased provider name as an env var
        other => std::env::var(other.to_uppercase()).ok(),
    };
    key.filter(|k| !k.is_empty())
}

/// Anthropic-specific configuration resolved from the environment.
/// Mirrors the env vars Claude Code supports so that any `.env` that
/// works with Claude Code also works here.
#[derive(serde::Serialize)]
pub struct AnthropicConfig {
    /// API key — checks ANTHROPIC_API_KEY then ANTHROPIC_AUTH_TOKEN
    pub api_key: Option<String>,
    /// Custom base URL (e.g. a proxy) — ANTHROPIC_BASE_URL
    pub base_url: Option<String>,
    /// Model override for claude-sonnet-* — ANTHROPIC_DEFAULT_SONNET_MODEL
    pub default_sonnet_model: Option<String>,
    /// Model override for claude-haiku-* — ANTHROPIC_DEFAULT_HAIKU_MODEL
    pub default_haiku_model: Option<String>,
    /// Model override for claude-opus-* — ANTHROPIC_DEFAULT_OPUS_MODEL
    pub default_opus_model: Option<String>,
}

fn non_empty(s: String) -> Option<String> {
    if s.is_empty() { None } else { Some(s) }
}

#[tauri::command]
pub fn get_anthropic_config() -> AnthropicConfig {
    let api_key = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .and_then(non_empty)
        .or_else(|| std::env::var("ANTHROPIC_AUTH_TOKEN").ok().and_then(non_empty));

    AnthropicConfig {
        api_key,
        base_url: std::env::var("ANTHROPIC_BASE_URL").ok().and_then(non_empty),
        default_sonnet_model: std::env::var("ANTHROPIC_DEFAULT_SONNET_MODEL").ok().and_then(non_empty),
        default_haiku_model: std::env::var("ANTHROPIC_DEFAULT_HAIKU_MODEL").ok().and_then(non_empty),
        default_opus_model: std::env::var("ANTHROPIC_DEFAULT_OPUS_MODEL").ok().and_then(non_empty),
    }
}
