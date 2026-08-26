/**
 * Bundled, curated catalog of installable MCP servers for the marketplace panel.
 *
 * This is intentionally a static, hand-vetted list (not a live remote registry
 * fetch) — every package name below was verified against the npm/PyPI registry
 * at the time it was added, so installing one just means running a package we
 * already know resolves. A live community registry (with its own trust/vetting
 * story) is a deliberate future phase, not this one.
 *
 * `command`/`args`/`env`/`url`/`headers` values may contain `{{token}}`
 * placeholders that match a `configFields[].key` — `buildServerEntry()` (see
 * marketplace.ts) substitutes them from user-supplied values before the entry
 * is written to `~/.aichemist/mcp.json`.
 */
import type { MarketplaceEntry } from "./marketplace";

export const MARKETPLACE_CATALOG: MarketplaceEntry[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Read, write, and search files within a directory you choose.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    tags: ["files"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "{{rootPath}}"],
    configFields: [
      {
        key: "rootPath",
        label: "Root directory",
        required: true,
        placeholder: "/Users/you/projects",
      },
    ],
  },
  {
    id: "memory",
    name: "Memory",
    description: "A persistent knowledge graph the agent can read and write across turns.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    tags: ["productivity"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Structured step-by-step reasoning tool for breaking down complex problems.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    tags: ["reasoning"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  {
    id: "fetch",
    name: "Fetch",
    description: "Fetch a URL and convert its content to Markdown for the agent to read.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    tags: ["web"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-fetch"],
  },
  {
    id: "time",
    name: "Time",
    description: "Timezone lookups and time conversions.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    tags: ["productivity"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-time"],
  },
  {
    id: "git",
    name: "Git",
    description: "Read, search, and inspect the history of a local Git repository.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/git",
    tags: ["dev-tools"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "{{repoPath}}"],
    configFields: [
      {
        key: "repoPath",
        label: "Repository path",
        required: true,
        placeholder: "/Users/you/projects/my-repo",
      },
    ],
  },
  {
    id: "github",
    name: "GitHub",
    description: "Manage GitHub repos, issues, and pull requests via the GitHub API.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/github",
    tags: ["dev-tools"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{githubToken}}" },
    configFields: [
      {
        key: "githubToken",
        label: "GitHub personal access token",
        required: true,
        secret: true,
      },
    ],
  },
  {
    id: "slack",
    name: "Slack",
    description: "Read and post messages in Slack channels via a bot token.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/slack",
    tags: ["productivity"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-slack"],
    env: {
      SLACK_BOT_TOKEN: "{{botToken}}",
      SLACK_TEAM_ID: "{{teamId}}",
    },
    configFields: [
      { key: "botToken", label: "Bot token (xoxb-…)", required: true, secret: true },
      { key: "teamId", label: "Team ID", required: true },
    ],
  },
  {
    id: "brave-search",
    name: "Brave Search",
    description: "Web search via the Brave Search API.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search",
    tags: ["web"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-brave-search"],
    env: { BRAVE_API_KEY: "{{apiKey}}" },
    configFields: [{ key: "apiKey", label: "Brave Search API key", required: true, secret: true }],
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Read-only inspection and querying of a Postgres database.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/postgres",
    tags: ["database"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres", "{{connectionString}}"],
    configFields: [
      {
        key: "connectionString",
        label: "Connection string",
        required: true,
        secret: true,
        placeholder: "postgresql://user:pass@localhost:5432/db",
      },
    ],
  },
  {
    id: "sqlite",
    name: "SQLite",
    description: "Read and query a local SQLite database file.",
    homepage: "https://pypi.org/project/mcp-server-sqlite/",
    tags: ["database"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "{{dbPath}}"],
    configFields: [
      { key: "dbPath", label: "Database file path", required: true, placeholder: "/path/to/db.sqlite" },
    ],
  },
  {
    id: "sentry",
    name: "Sentry",
    description: "Look up and triage Sentry issues and events.",
    homepage: "https://pypi.org/project/mcp-server-sentry/",
    tags: ["dev-tools"],
    transport: "stdio",
    command: "uvx",
    args: ["mcp-server-sentry", "--auth-token", "{{authToken}}"],
    configFields: [{ key: "authToken", label: "Sentry auth token", required: true, secret: true }],
  },
  {
    id: "puppeteer",
    name: "Puppeteer",
    description: "Browser automation — navigate pages, take screenshots, and click/fill forms.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer",
    tags: ["web", "automation"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  {
    id: "everything",
    name: "Everything (reference server)",
    description: "Anthropic's reference server exercising every MCP feature — useful for testing.",
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/everything",
    tags: ["reference"],
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
  },
];
