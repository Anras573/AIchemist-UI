// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseMcpListOutput,
  commandFingerprints,
  readDotCopilotMcp,
  readVsCodeMcp,
  readCopilotMcpServers,
  mergeMcpServers,
} from "./mcp-utils";
import type { McpServerInfo } from "../src/types/index";

vi.mock("fs");
vi.mock("os", () => ({ default: { homedir: () => "/home/user" }, homedir: () => "/home/user" }));

import * as fs from "fs";

// ── parseMcpListOutput ────────────────────────────────────────────────────────

describe("parseMcpListOutput", () => {
  it("parses a connected stdio server", () => {
    const output = "Checking MCP server health...\nTADA-MCP: npx -y @lego/tada-mcp - ✓ Connected\n";
    const result = parseMcpListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "TADA-MCP",
      command: "npx -y @lego/tada-mcp",
      transport: undefined,
      connected: true,
      status: "Connected",
      source: "claude",
    });
  });

  it("parses a failed HTTP server", () => {
    const output = "plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect\n";
    const result = parseMcpListOutput(output);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: "plugin:github:github",
      command: "https://api.githubcopilot.com/mcp/",
      transport: "HTTP",
      connected: false,
      status: "Failed to connect",
      source: "claude",
    });
  });

  it("strips the transport hint from the command string", () => {
    const output = "atlassian: https://mcp.atlassian.com/v1/mcp (HTTP) - ✓ Connected\n";
    const [server] = parseMcpListOutput(output);
    expect(server.command).toBe("https://mcp.atlassian.com/v1/mcp");
    expect(server.transport).toBe("HTTP");
  });

  it("skips the 'Checking MCP server health...' header line", () => {
    const output = "Checking MCP server health...\n";
    expect(parseMcpListOutput(output)).toHaveLength(0);
  });

  it("skips blank lines and unrecognised lines", () => {
    const output = "\n\nsome unrelated text\nMCP_DOCKER: docker mcp gateway run - ✓ Connected\n";
    expect(parseMcpListOutput(output)).toHaveLength(1);
  });

  it("parses multiple servers", () => {
    const output = [
      "Checking MCP server health...",
      "plugin:context7:context7: npx -y @upstash/context7-mcp - ✓ Connected",
      "plugin:github:github: https://api.githubcopilot.com/mcp/ (HTTP) - ✗ Failed to connect",
      "MCP_DOCKER: docker mcp gateway run - ✓ Connected",
    ].join("\n");
    const result = parseMcpListOutput(output);
    expect(result).toHaveLength(3);
    expect(result.map((s) => s.name)).toEqual([
      "plugin:context7:context7",
      "plugin:github:github",
      "MCP_DOCKER",
    ]);
  });
});

// ── commandFingerprints ───────────────────────────────────────────────────────

describe("commandFingerprints", () => {
  it("extracts and normalises an HTTP URL", () => {
    expect(commandFingerprints("https://mcp.atlassian.com/v1/mcp")).toEqual(
      new Set(["https://mcp.atlassian.com/v1/mcp"])
    );
  });

  it("strips trailing slash from URLs", () => {
    expect(commandFingerprints("https://api.githubcopilot.com/mcp/")).toEqual(
      new Set(["https://api.githubcopilot.com/mcp"])
    );
  });

  it("lowercases URLs", () => {
    expect(commandFingerprints("https://EXAMPLE.COM/mcp")).toEqual(
      new Set(["https://example.com/mcp"])
    );
  });

  it("extracts npm package from 'npx -y @scope/pkg'", () => {
    expect(commandFingerprints("npx -y @lego/tada-mcp")).toEqual(
      new Set(["@lego/tada-mcp"])
    );
  });

  it("extracts npm package from 'npx @scope/pkg@version'", () => {
    expect(commandFingerprints("npx @upstash/context7-mcp@1.0.31")).toEqual(
      new Set(["@upstash/context7-mcp"])
    );
  });

  it("extracts npm package from 'npx pkg@latest'", () => {
    expect(commandFingerprints("npx chrome-devtools-mcp@latest")).toEqual(
      new Set(["chrome-devtools-mcp"])
    );
  });

  it("extracts package from uvx --from", () => {
    expect(commandFingerprints("uvx --from mempalace python -m mempalace.mcp_server")).toEqual(
      new Set(["mempalace"])
    );
  });

  it("extracts docker image name (strips tag)", () => {
    const cmd = "docker run --rm -i mcp/markitdown@sha256:1cef3bf502503310ed0884441874ccf6cdaac20136dc1179797fa048269dc4cb";
    expect(commandFingerprints(cmd)).toEqual(new Set(["mcp/markitdown"]));
  });

  it("uses full command for non-run docker commands", () => {
    expect(commandFingerprints("docker mcp gateway run")).toEqual(
      new Set(["docker mcp gateway run"])
    );
  });

  it("falls back to the normalised full command for unknown formats", () => {
    expect(commandFingerprints("aspire mcp start")).toEqual(
      new Set(["aspire mcp start"])
    );
  });

  // Cross-config matching — the core correctness requirement
  it.each([
    ["plugin:github:github (Claude)", "https://api.githubcopilot.com/mcp/", "https://api.githubcopilot.com/mcp/"],
    ["atlassian (Claude vs VSCode)", "https://mcp.atlassian.com/v1/mcp", "https://mcp.atlassian.com/v1/mcp"],
    ["MCP_DOCKER", "docker mcp gateway run", "docker mcp gateway run"],
    ["TADA-MCP vs tada", "npx -y @lego/tada-mcp", "npx -y @lego/tada-mcp"],
    ["context7 (version differs)", "npx -y @upstash/context7-mcp", "npx @upstash/context7-mcp@1.0.31"],
    ["microsoft-docs", "https://learn.microsoft.com/api/mcp", "https://learn.microsoft.com/api/mcp"],
  ])("matches %s across configs", (_label, claudeCmd, copilotCmd) => {
    const cf = commandFingerprints(claudeCmd);
    const pf = commandFingerprints(copilotCmd);
    const overlap = [...cf].some((fp) => pf.has(fp));
    expect(overlap).toBe(true);
  });
});

// ── readDotCopilotMcp ─────────────────────────────────────────────────────────

describe("readDotCopilotMcp", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns stdio entries from mcpServers", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        aspire: { type: "local", command: "aspire", args: ["mcp", "start"] },
      },
    }));
    const result = readDotCopilotMcp();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ name: "aspire", command: "aspire mcp start", transport: "stdio" });
  });

  it("returns HTTP entries when url is present", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      mcpServers: {
        myserver: { type: "http", url: "https://example.com/mcp" },
      },
    }));
    const [entry] = readDotCopilotMcp();
    expect(entry).toMatchObject({ command: "https://example.com/mcp", transport: "HTTP" });
  });

  it("returns [] when file is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readDotCopilotMcp()).toEqual([]);
  });

  it("returns [] when JSON is malformed", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("not json");
    expect(readDotCopilotMcp()).toEqual([]);
  });
});

// ── readVsCodeMcp ─────────────────────────────────────────────────────────────

describe("readVsCodeMcp", () => {
  beforeEach(() => vi.resetAllMocks());

  it("parses the servers map from mcp.json", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      servers: {
        MCP_DOCKER: { type: "stdio", command: "docker", args: ["mcp", "gateway", "run"] },
        github: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      },
    }));
    const result = readVsCodeMcp("/fake/mcp.json");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "MCP_DOCKER", command: "docker mcp gateway run", transport: "stdio" });
    expect(result[1]).toMatchObject({ name: "github", command: "https://api.githubcopilot.com/mcp/", transport: "HTTP" });
  });

  it("returns [] when file is missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    expect(readVsCodeMcp("/missing.json")).toEqual([]);
  });
});

// ── readCopilotMcpServers ─────────────────────────────────────────────────────

describe("readCopilotMcpServers", () => {
  beforeEach(() => vi.resetAllMocks());

  it("deduplicates a server present in both config files", () => {
    vi.mocked(fs.readFileSync)
      // First call = ~/.copilot/mcp-config.json
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
      }))
      // Second call = VS Code mcp.json (first platform candidate)
      .mockReturnValueOnce(JSON.stringify({
        servers: { "microsoft/playwright-mcp": { type: "stdio", command: "npx", args: ["@playwright/mcp@latest"] } },
      }));

    const result = readCopilotMcpServers();
    // Both resolve to fingerprint "@playwright/mcp" — should appear only once.
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("copilot");
  });

  it("keeps distinct servers from both files", () => {
    vi.mocked(fs.readFileSync)
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: { aspire: { command: "aspire", args: ["mcp", "start"] } },
      }))
      .mockReturnValueOnce(JSON.stringify({
        servers: { MCP_DOCKER: { type: "stdio", command: "docker", args: ["mcp", "gateway", "run"] } },
      }));

    const result = readCopilotMcpServers();
    expect(result).toHaveLength(2);
  });
});

// ── mergeMcpServers ───────────────────────────────────────────────────────────

describe("mergeMcpServers", () => {
  const makeServer = (overrides: Partial<McpServerInfo>): McpServerInfo => ({
    name: "test",
    command: "npx test-pkg",
    connected: null,
    status: "Configured",
    source: "claude",
    ...overrides,
  });

  it("promotes a Claude server to 'both' when Copilot has a matching fingerprint", () => {
    const claude = [makeServer({ name: "TADA-MCP", command: "npx -y @lego/tada-mcp", connected: true, source: "claude" })];
    const copilot = [makeServer({ name: "tada", command: "npx -y @lego/tada-mcp", source: "copilot" })];
    const result = mergeMcpServers(claude, copilot);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("both");
    // Live status from Claude is preserved
    expect(result[0].connected).toBe(true);
    expect(result[0].name).toBe("TADA-MCP");
  });

  it("keeps a Claude-only server as 'claude'", () => {
    const claude = [makeServer({ name: "local-only", command: "npx local-tool", source: "claude" })];
    const result = mergeMcpServers(claude, []);
    expect(result[0].source).toBe("claude");
  });

  it("appends Copilot-only servers at the end", () => {
    const claude = [makeServer({ name: "claude-server", command: "npx claude-pkg", source: "claude" })];
    const copilot = [makeServer({ name: "copilot-only", command: "aspire mcp start", source: "copilot" })];
    const result = mergeMcpServers(claude, copilot);
    expect(result).toHaveLength(2);
    expect(result[1]).toMatchObject({ name: "copilot-only", source: "copilot" });
  });

  it("does not duplicate a server that appears in both lists", () => {
    const cmd = "https://mcp.atlassian.com/v1/mcp";
    const claude = [makeServer({ name: "atlassian", command: cmd, source: "claude" })];
    const copilot = [makeServer({ name: "com.atlassian/atlassian-mcp-server", command: cmd, source: "copilot" })];
    const result = mergeMcpServers(claude, copilot);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("both");
  });

  it("handles empty inputs", () => {
    expect(mergeMcpServers([], [])).toEqual([]);
    const s = makeServer({ source: "claude" });
    expect(mergeMcpServers([s], [])).toHaveLength(1);
    expect(mergeMcpServers([], [makeServer({ source: "copilot" })])).toHaveLength(1);
  });
});
