# Providers

AIchemist UI supports five AI providers. Every session is locked to one provider at creation, but you can freely mix providers across sessions — even within the same project.

| Provider | What it is | Needs |
|---|---|---|
| **Anthropic** | Claude models via the Claude Agent SDK | `ANTHROPIC_API_KEY` or a Claude Pro/Max login |
| **GitHub Copilot** | Copilot's agent models | `GITHUB_TOKEN` with Copilot access |
| **Codex** | OpenAI's Codex coding agent (runs the Codex CLI) | `OPENAI_API_KEY` |
| **Ollama** | Fully local models | A running Ollama daemon with ≥1 model pulled |
| **OpenAI-compatible** | Any server speaking the OpenAI API (LM Studio, vLLM, llama.cpp, Together, …) | Endpoint(s) configured in Settings → Providers |

## Anthropic (Claude)

Add to `~/.aichemist/.env`:

```ini
ANTHROPIC_API_KEY=sk-ant-...
```

- If you're a **Claude Pro/Max subscriber** logged in via the Claude CLI, the app picks up your existing login (`~/.claude/.credentials.json`) — no API key required.
- `ANTHROPIC_AUTH_TOKEN` works as a fallback token, and `ANTHROPIC_BASE_URL` points the app at a proxy or gateway.
- Behind an enterprise gateway you can also remap model names with `ANTHROPIC_DEFAULT_SONNET_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and `ANTHROPIC_DEFAULT_OPUS_MODEL` (matched by substring against the selected model id).

Claude sessions also discover agents and skills from your `~/.claude/` directory — see [Agents & skills](agents-and-skills.md).

## GitHub Copilot

Add to `~/.aichemist/.env`:

```ini
GITHUB_TOKEN=ghp_...
```

The token must belong to an account with an active Copilot subscription. Copilot sessions support streaming **reasoning** display, custom agents, skills, MCP servers, and memory like the other providers.

## Codex (OpenAI)

Add to `~/.aichemist/.env`:

```ini
OPENAI_API_KEY=sk-...
```

Codex is different from the other providers: it's a **self-driving coding agent** that executes its own tools (shell, file edits, MCP) inside its own sandbox. In interactive sessions its command executions and file writes are still bridged into AIchemist's normal approval dialogs, so you stay in the loop.

- `OPENAI_BASE_URL` redirects both the agent and model listing to a compatible gateway.
- The Codex CLI binary ships with the app's dependencies; `CODEX_CLI_PATH` overrides its location if needed.

## Ollama (local)

No key needed — install [Ollama](https://ollama.com), start it, and pull at least one model:

```bash
ollama pull llama3.2
```

- The app talks to your local daemon by default; set `OLLAMA_HOST` in `.env` to use a remote one.
- If no models are installed, Ollama shows as unavailable with a message telling you to pull one.
- Ollama is a first-class provider: tools (file read/write, shell, web fetch), skills, agents, MCP servers, and memory all work.
- **Extended thinking** is enabled automatically for models that support it (e.g. reasoning models) and shown in the Reasoning block.
- Models can **delegate sub-tasks** to another installed model via the built-in `delegate_task` tool.

## OpenAI-compatible endpoints

For anything that speaks the OpenAI API: LM Studio, vLLM, llama.cpp's server, Together, Groq, and so on.

Configure endpoints in **Settings → Providers**:

1. Add an endpoint with a **name**, **base URL** (e.g. `http://localhost:1234/v1`), and optionally an API key and extra headers.
2. Available models are listed from each endpoint's `/models`.
3. You can add **multiple endpoints** — models are shown as `endpoint/model-id` so it's always clear which server serves what.

Endpoints are stored in `~/.aichemist/openai-providers.json` (created with owner-only permissions since it may contain keys). Like Ollama, this provider supports tools, skills, agents, MCP, memory, and sub-task delegation.

## Availability & disabling providers

The new-session menus probe each provider (key present? server reachable?) and grey out unusable ones with the reason — a missing key, an unreachable server, or "Disabled in settings".

To hide providers you never use, open **Settings → Providers** and disable them. Existing sessions keep working — disabling a provider only hides it from the new-session pickers.
