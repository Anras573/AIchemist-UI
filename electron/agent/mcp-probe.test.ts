// @vitest-environment node
import { describe, it, expect, beforeEach } from "vitest";
import {
  probeManagedServers,
  _resetProbeCache,
  _setSdkLoader,
  type ProbeResult,
} from "./mcp-probe";
import type { McpServersMap } from "../mcp-config";

interface StubOpts {
  listToolsResult?: { tools: { name: string }[] };
  connectDelayMs?: number;
  connectThrows?: Error;
}

function makeSdkLoader(opts: StubOpts) {
  let stdioConstructed = 0;
  let httpConstructed = 0;
  let sseConstructed = 0;

  const loader = async () => ({
    Client: class {
      constructor(_info: unknown, _opts: unknown) {}
      async connect(_t: unknown) {
        if (opts.connectDelayMs) await new Promise((r) => setTimeout(r, opts.connectDelayMs));
        if (opts.connectThrows) throw opts.connectThrows;
      }
      async listTools() {
        return opts.listToolsResult ?? { tools: [] };
      }
      async close() {}
    } as never,
    StdioClientTransport: class {
      constructor(_p: unknown) { stdioConstructed++; }
      async close() {}
    } as never,
    StreamableHTTPClientTransport: class {
      constructor(_url: URL) { httpConstructed++; }
      async close() {}
    } as never,
    SSEClientTransport: class {
      constructor(_url: URL) { sseConstructed++; }
      async close() {}
    } as never,
  });

  return {
    loader,
    counts: () => ({ stdio: stdioConstructed, http: httpConstructed, sse: sseConstructed }),
  };
}

beforeEach(() => {
  _resetProbeCache();
  _setSdkLoader(null);
});

describe("probeManagedServers", () => {
  it("returns connected:true and tool names when probe succeeds", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [{ name: "read" }, { name: "write" }] } });
    _setSdkLoader(loader);

    const map: McpServersMap = { foo: { command: "echo", args: [] } };
    const results = await probeManagedServers(map);

    expect(results.get("foo")?.connected).toBe(true);
    expect(results.get("foo")?.tools).toEqual(["read", "write"]);
    expect(results.get("foo")?.error).toBeUndefined();
    expect(results.get("foo")?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("returns connected:true with empty tools when server exposes none", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [] } });
    _setSdkLoader(loader);

    const results = await probeManagedServers({ bar: { command: "x" } });
    expect(results.get("bar")?.connected).toBe(true);
    expect(results.get("bar")?.tools).toEqual([]);
  });

  it("captures error message when connect throws", async () => {
    const { loader } = makeSdkLoader({ connectThrows: new Error("ENOENT: spawn nonexistent-cmd") });
    _setSdkLoader(loader);

    const results = await probeManagedServers({ broken: { command: "nonexistent-cmd" } });
    expect(results.get("broken")?.connected).toBe(false);
    expect(results.get("broken")?.error).toContain("ENOENT");
    expect(results.get("broken")?.tools).toEqual([]);
  });

  it("times out and returns descriptive error", async () => {
    const { loader } = makeSdkLoader({ connectDelayMs: 200 });
    _setSdkLoader(loader);

    const results = await probeManagedServers(
      { slow: { command: "sleep" } },
      { timeoutMs: 50 },
    );
    expect(results.get("slow")?.connected).toBe(false);
    expect(results.get("slow")?.error).toMatch(/Timed out after 50ms/);
  });

  it("filters out reserved aichemist-tools name", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [{ name: "x" }] } });
    _setSdkLoader(loader);

    const results = await probeManagedServers({
      "aichemist-tools": { command: "should-not-spawn" },
      ok: { command: "echo" },
    });
    expect(results.has("aichemist-tools")).toBe(false);
    expect(results.has("ok")).toBe(true);
  });

  it("caches results within TTL window", async () => {
    let callCount = 0;
    const loader = async () => ({
      Client: class {
        constructor(_i: unknown, _o: unknown) {}
        async connect() {}
        async listTools() {
          callCount++;
          return { tools: [{ name: "t" }] };
        }
        async close() {}
      } as never,
      StdioClientTransport: class { async close() {} } as never,
      StreamableHTTPClientTransport: class { async close() {} } as never,
      SSEClientTransport: class { async close() {} } as never,
    });
    _setSdkLoader(loader);

    const map: McpServersMap = { a: { command: "echo" } };
    await probeManagedServers(map);
    await probeManagedServers(map);
    await probeManagedServers(map);
    expect(callCount).toBe(1);
  });

  it("re-probes when force:true", async () => {
    let callCount = 0;
    const loader = async () => ({
      Client: class {
        constructor(_i: unknown, _o: unknown) {}
        async connect() {}
        async listTools() {
          callCount++;
          return { tools: [] };
        }
        async close() {}
      } as never,
      StdioClientTransport: class { async close() {} } as never,
      StreamableHTTPClientTransport: class { async close() {} } as never,
      SSEClientTransport: class { async close() {} } as never,
    });
    _setSdkLoader(loader);

    const map: McpServersMap = { a: { command: "echo" } };
    await probeManagedServers(map);
    await probeManagedServers(map, { force: true });
    expect(callCount).toBe(2);
  });

  it("re-probes when the map fingerprint changes", async () => {
    let callCount = 0;
    const loader = async () => ({
      Client: class {
        constructor(_i: unknown, _o: unknown) {}
        async connect() {}
        async listTools() {
          callCount++;
          return { tools: [] };
        }
        async close() {}
      } as never,
      StdioClientTransport: class { async close() {} } as never,
      StreamableHTTPClientTransport: class { async close() {} } as never,
      SSEClientTransport: class { async close() {} } as never,
    });
    _setSdkLoader(loader);

    await probeManagedServers({ a: { command: "echo" } });
    await probeManagedServers({ a: { command: "echo" }, b: { command: "ls" } });
    expect(callCount).toBe(3);
  });

  it("uses HTTP transport when entry has url, stdio when it has command", async () => {
    const { loader, counts } = makeSdkLoader({ listToolsResult: { tools: [] } });
    _setSdkLoader(loader);

    await probeManagedServers({
      remote: { type: "http", url: "https://example.com/mcp" },
      sseServer: { type: "sse", url: "https://example.com/sse" },
      local: { command: "echo" },
    });

    expect(counts()).toEqual({ stdio: 1, http: 1, sse: 1 });
  });

  it("returns empty map for empty input", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [] } });
    _setSdkLoader(loader);

    const results = await probeManagedServers({});
    expect(results.size).toBe(0);
  });

  it("respects stdio concurrency cap", async () => {
    let active = 0;
    let peak = 0;
    const loader = async () => ({
      Client: class {
        constructor(_i: unknown, _o: unknown) {}
        async connect() {}
        async listTools() {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 30));
          active--;
          return { tools: [] };
        }
        async close() {}
      } as never,
      StdioClientTransport: class { async close() {} } as never,
      StreamableHTTPClientTransport: class { async close() {} } as never,
      SSEClientTransport: class { async close() {} } as never,
    });
    _setSdkLoader(loader);

    const map: McpServersMap = {};
    for (let i = 0; i < 8; i++) map[`s${i}`] = { command: "echo" };

    await probeManagedServers(map, { stdioConcurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("rejects HTTP entries missing url with descriptive error", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [] } });
    _setSdkLoader(loader);

    const results = await probeManagedServers({ x: { type: "http" } });
    expect(results.get("x")?.connected).toBe(false);
    expect(results.get("x")?.error).toMatch(/no `url`/);
  });

  it("rejects stdio entries missing command with descriptive error", async () => {
    const { loader } = makeSdkLoader({ listToolsResult: { tools: [] } });
    _setSdkLoader(loader);

    const results = await probeManagedServers({ x: { args: ["foo"] } });
    expect(results.get("x")?.connected).toBe(false);
    expect(results.get("x")?.error).toMatch(/no `command`/);
  });
});

describe("ProbeResult type", () => {
  it("compiles with expected shape", () => {
    const r: ProbeResult = { connected: true, tools: [], durationMs: 0 };
    expect(r.connected).toBe(true);
  });
});
