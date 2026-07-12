# MCP servers

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) lets you plug external tools into your agents — databases, browsers, issue trackers, internal APIs. AIchemist UI manages its own MCP server list and injects it into **every provider** (Claude, Copilot, Codex, Ollama, OpenAI-compatible), so a server you configure once is available everywhere.

## Configuring servers

Open **Settings → MCP Servers**. The **AIchemist** scope is the app-managed list, stored in `~/.aichemist/mcp.json` — the app never writes to Claude's or Copilot's own config files.

- Add, edit, and delete servers in a form or raw-JSON view. Stdio (local command), HTTP, and SSE transports are supported.
- Each row in the AIchemist scope shows **live health**: connected or not, how many tools the server exposes, and any connection error. Use the refresh button to re-probe immediately.
- Servers from Claude's and Copilot's own configs are shown under their respective scope tabs, so you can see everything your agents can reach in one place.

You can also drop a standard **`.mcp.json`** at a project's root — both the Claude and Copilot SDKs discover it natively.

## Using servers in a session

The **MCP** tab in a session's right panel lists the servers that apply to that session:

- App-managed servers carry a violet **AIchemist** badge and are available to all providers.
- Provider-specific servers (from Claude's or Copilot's own config) appear only in sessions for that provider.
- Each app-managed server has a **per-session toggle** — disable a noisy or irrelevant server for one session without touching the global config. The change applies from the next message.

MCP tool calls go through the same [approval gate](projects-and-sessions.md#tool-approvals) as built-in tools.
