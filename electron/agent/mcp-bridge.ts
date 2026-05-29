import * as crypto from "crypto";
import type { McpServerEntry, McpServersMap } from "../mcp-config";

interface SdkModules {
  Client: new (info: unknown, opts: unknown) => {
    connect(transport: unknown): Promise<void>;
    listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
    callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
      content?: Array<{ type?: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    }>;
    close(): Promise<void>;
  };
  StdioClientTransport: new (params: {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    stderr?: string;
  }) => { close: () => Promise<void> };
  StreamableHTTPClientTransport: new (url: URL, opts?: TransportOptions) => { close: () => Promise<void> };
  SSEClientTransport: new (url: URL, opts?: TransportOptions) => { close: () => Promise<void> };
}

interface TransportOptions {
  requestInit?: {
    headers?: Record<string, string>;
  };
}

interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools?: Array<{ name: string; description?: string; inputSchema?: unknown }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content?: Array<{ type?: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }>;
  close(): Promise<void>;
}

export interface OllamaMcpToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ToolBinding {
  serverName: string;
  toolName: string;
  client: McpClientLike;
}

export interface ManagedMcpBridge {
  tools: OllamaMcpToolDefinition[];
  hasTool(name: string): boolean;
  callTool(name: string, args: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

let sdkLoader: () => Promise<SdkModules> = async () => {
  const [client, stdio, http, sse] = await Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/sse.js"),
  ]);
  return {
    Client: client.Client as unknown as SdkModules["Client"],
    StdioClientTransport: stdio.StdioClientTransport as unknown as SdkModules["StdioClientTransport"],
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport as unknown as SdkModules["StreamableHTTPClientTransport"],
    SSEClientTransport: sse.SSEClientTransport as unknown as SdkModules["SSEClientTransport"],
  };
};

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (schema && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    if (record.type === "object") {
      return record;
    }
  }
  return { type: "object", properties: {} };
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_")
    .slice(0, 32) || "tool";
}

function makeFunctionName(serverName: string, toolName: string): string {
  const hash = crypto.createHash("sha1").update(`${serverName}\0${toolName}`).digest("hex").slice(0, 8);
  return `mcp__${slug(serverName)}__${slug(toolName)}__${hash}`;
}

function stringifyResult(result: {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}): string {
  const content = result.content ?? [];
  const textBlocks = content.filter((block): block is { type?: string; text?: string } => block?.type === "text");
  if (textBlocks.length === content.length && !result.structuredContent) {
    const text = textBlocks.map((block) => block.text ?? "").join("\n");
    return result.isError ? `Error: ${text}` : text;
  }
  return safeJson(result);
}

function makeTransportOptions(entry: McpServerEntry): TransportOptions | undefined {
  if (!entry.headers) return undefined;
  return {
    requestInit: {
      headers: entry.headers,
    },
  };
}

async function createTransport(entry: McpServerEntry, sdk: SdkModules): Promise<{ close: () => Promise<void> }> {
  const isHttp = entry.type === "http" || entry.type === "sse" || (entry.url != null && entry.type !== "stdio");
  if (isHttp) {
    const url = entry.url?.trim();
    if (!url) throw new Error("HTTP/SSE server config has no `url`");
    if (entry.type === "sse") {
      return new sdk.SSEClientTransport(new URL(url), makeTransportOptions(entry));
    }
    return new sdk.StreamableHTTPClientTransport(new URL(url), makeTransportOptions(entry));
  }

  if (!entry.command) throw new Error("Stdio server config has no `command`");
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  return new sdk.StdioClientTransport({
    command: entry.command,
    args: Array.isArray(entry.args) ? entry.args : [],
    env: { ...env, ...(entry.env ?? {}) },
    stderr: "pipe",
  });
}

/**
 * Create a best-effort bridge over a managed MCP server map. Servers that fail
 * to connect or list tools are skipped so one bad entry does not break the turn.
 */
export async function createManagedMcpBridge(map: McpServersMap): Promise<ManagedMcpBridge> {
  const filteredEntries = Object.entries(map).filter(([name]) => name !== "aichemist-tools");
  if (filteredEntries.length === 0) {
    return {
      tools: [],
      hasTool: () => false,
      callTool: async () => "Error: Unsupported MCP tool",
      close: async () => {},
    };
  }

  let sdk: SdkModules;
  try {
    sdk = await sdkLoader();
  } catch (err) {
    console.warn(`[ollama-mcp] MCP SDK unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return {
      tools: [],
      hasTool: () => false,
      callTool: async () => "Error: Unsupported MCP tool",
      close: async () => {},
    };
  }

  const tools: OllamaMcpToolDefinition[] = [];
  const bindings = new Map<string, ToolBinding>();
  const connections = new Map<string, { client: McpClientLike; transport: { close: () => Promise<void> } }>();

  await Promise.all(
    filteredEntries.map(async ([serverName, entry]) => {
      let transport: { close: () => Promise<void> } | null = null;
      let client: McpClientLike | null = null;
      try {
        transport = await createTransport(entry, sdk);
        client = new sdk.Client({ name: "aichemist-ollama-mcp", version: "1.0.0" }, { capabilities: {} });
        await client.connect(transport as never);
        const listed = await client.listTools();
        const serverTools = listed.tools ?? [];

        if (serverTools.length === 0) {
          await transport.close();
          await client.close();
          return;
        }

        connections.set(serverName, { client, transport });
        for (const tool of serverTools) {
          const functionName = makeFunctionName(serverName, tool.name);
          bindings.set(functionName, { serverName, toolName: tool.name, client });
          tools.push({
            type: "function",
            function: {
              name: functionName,
              description: [serverName, tool.name, tool.description].filter(Boolean).join(" — "),
              parameters: normalizeSchema(tool.inputSchema),
            },
          });
        }
      } catch (err) {
        console.warn(
          `[ollama-mcp] Failed to load "${serverName}": ${err instanceof Error ? err.message : String(err)}`
        );
        try { await transport?.close(); } catch { /* ignore */ }
        try { await client?.close(); } catch { /* ignore */ }
      }
    }),
  );

  tools.sort((a, b) => a.function.name.localeCompare(b.function.name));

  return {
    tools,
    hasTool(name: string): boolean {
      return bindings.has(name);
    },
    async callTool(name: string, args: Record<string, unknown>): Promise<string> {
      const binding = bindings.get(name);
      if (!binding) return `Error: Unsupported MCP tool "${name}"`;
      try {
        const result = await binding.client.callTool({
          name: binding.toolName,
          arguments: args,
        });
        return stringifyResult(result);
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
    async close(): Promise<void> {
      await Promise.all(
        [...connections.values()].map(async ({ client, transport }) => {
          try { await transport.close(); } catch { /* ignore */ }
          try { await client.close(); } catch { /* ignore */ }
        }),
      );
    },
  };
}
