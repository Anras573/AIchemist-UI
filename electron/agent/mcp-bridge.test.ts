// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedMcpBridge } from "./mcp-bridge";

const mocks = {
  clientCtor: vi.fn(),
  connect: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
  clientClose: vi.fn(),
  transportClose: vi.fn(),
  stdioCtor: vi.fn(),
  httpCtor: vi.fn(),
  sseCtor: vi.fn(),
};

vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mocks.clientCtor,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mocks.stdioCtor,
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: mocks.httpCtor,
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: mocks.sseCtor,
}));

describe("createManagedMcpBridge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connect.mockResolvedValue(undefined);
    mocks.listTools.mockResolvedValue({
      tools: [
        {
          name: "lookup",
          description: "Lookup docs",
          inputSchema: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      ],
    });
    mocks.callTool.mockResolvedValue({
      content: [{ type: "text", text: "bridge result" }],
    });
    mocks.clientClose.mockResolvedValue(undefined);
    mocks.transportClose.mockResolvedValue(undefined);
    mocks.clientCtor.mockImplementation(function () {
      return {
        connect: mocks.connect,
        listTools: mocks.listTools,
        callTool: mocks.callTool,
        close: mocks.clientClose,
      };
    });
    mocks.stdioCtor.mockImplementation(function () {
      return { close: mocks.transportClose };
    });
    mocks.httpCtor.mockImplementation(function () {
      return { close: mocks.transportClose };
    });
    mocks.sseCtor.mockImplementation(function () {
      return { close: mocks.transportClose };
    });
  });

  it("namespaces tools and proxies calls through the MCP client", async () => {
    const bridge = await createManagedMcpBridge({
      docs: { command: "npx -y docs-mcp" },
    });

    expect(bridge.tools).toHaveLength(1);
    expect(bridge.tools[0].function.name).toMatch(/^mcp__docs__lookup__/);
    expect(bridge.tools[0].function.parameters).toEqual(
      expect.objectContaining({
        type: "object",
        properties: { q: { type: "string" } },
        required: ["q"],
      }),
    );

    const output = await bridge.callTool(bridge.tools[0].function.name, { q: "needle" });
    expect(output).toBe("bridge result");
    expect(mocks.callTool).toHaveBeenCalledWith({ name: "lookup", arguments: { q: "needle" } });

    await bridge.close();
    expect(mocks.transportClose).toHaveBeenCalled();
    expect(mocks.clientClose).toHaveBeenCalled();
  });

  it("passes HTTP and SSE headers through to transport constructors", async () => {
    const bridge = await createManagedMcpBridge({
      httpDocs: { type: "http", url: "https://example.test/mcp", headers: { Authorization: "Bearer http" } },
      sseDocs: { type: "sse", url: "https://example.test/sse", headers: { Authorization: "Bearer sse" } },
    });

    expect(mocks.httpCtor).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { Authorization: "Bearer http" } } },
    );
    expect((mocks.httpCtor.mock.calls[0][0] as URL).href).toBe("https://example.test/mcp");
    expect(mocks.sseCtor).toHaveBeenCalledWith(
      expect.any(URL),
      { requestInit: { headers: { Authorization: "Bearer sse" } } },
    );
    expect((mocks.sseCtor.mock.calls[0][0] as URL).href).toBe("https://example.test/sse");

    await bridge.close();
  });
});
