# Settings reference

## The Settings hub

Open Settings from the app to configure:

| Section | What's there |
|---|---|
| **Defaults** | Default provider for new projects, default approval mode, theme, and the max tool rounds per turn for self-driven providers (Ollama / OpenAI-compatible; 1–100, default 8). |
| **Providers** | Enable/disable providers app-wide, and manage OpenAI-compatible endpoints (name, base URL, API key, headers). |
| **Agents** | Create, edit, and delete agent files. |
| **Skills** | Create, edit, and delete skills. |
| **MCP Servers** | The MCP config editor with per-server live health. |
| **Spending** | Budget (period, global and per-provider caps) and pricing overrides. |

Per-**project** settings (default provider/model, approval mode and rules, worktree options) live in each project's own settings.

## `~/.aichemist/.env` — API keys & environment

Loaded once at app startup; restart after editing.

| Variable | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Primary Anthropic key |
| `ANTHROPIC_AUTH_TOKEN` | Fallback Anthropic token (used when the key is absent) |
| `ANTHROPIC_BASE_URL` | Custom Anthropic endpoint / proxy |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override any model id containing `sonnet` |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override any model id containing `haiku` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override any model id containing `opus` |
| `GITHUB_TOKEN` | GitHub Copilot token |
| `OPENAI_API_KEY` | OpenAI key (Codex provider) |
| `OPENAI_BASE_URL` | Custom OpenAI endpoint / gateway (Codex) |
| `OLLAMA_HOST` | Ollama server URL (defaults to the local daemon) |
| `CLAUDE_CODE_PATH` | Explicit path to the `claude` CLI binary |
| `CODEX_CLI_PATH` | Explicit path to the `codex` CLI binary |

## Files under `~/.aichemist/`

| File | Contents |
|---|---|
| `aichemist.db` | All projects, sessions, messages, tool calls, workflows, and usage (SQLite) |
| `.env` | API keys (table above) |
| `mcp.json` | App-managed [MCP servers](mcp-servers.md) |
| `openai-providers.json` | [OpenAI-compatible endpoints](providers.md#openai-compatible-endpoints) (owner-only file permissions) |
| `budget.json` | [Spending budget](spending.md#budgets) |
| `pricing-overrides.json` | Custom per-model prices for cost estimation |
| `memory/` | Per-project [agent memory](memory-and-traces.md#memory) (non-Claude providers) |
| `traces/` | Session transcripts for Ollama / OpenAI-compatible sessions |

## Files in a project

| Path | Contents |
|---|---|
| `.agents/skills/<name>/SKILL.md` | Project-level [skills](agents-and-skills.md#skills) |
| `.agents/copilot-agents/*.md` | Project-level Copilot [agents](agents-and-skills.md#agents) |
| `.mcp.json` | Project-level MCP servers (discovered natively by the Claude & Copilot SDKs) |
