// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mapRegistryServer,
  registryEntryId,
  fetchRegistryEntries,
  _setRegistryFetch,
} from "./marketplace-registry";

beforeEach(() => _setRegistryFetch(null));

const jsonRes = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as Response;

describe("mapRegistryServer", () => {
  it("maps an npm stdio package with a secret env var to a config field", () => {
    const e = mapRegistryServer({
      name: "com.acme/mcp",
      title: "Acme",
      description: "d",
      packages: [
        {
          registryType: "npm",
          identifier: "@acme/mcp",
          version: "1.2.3",
          transport: { type: "stdio" },
          packageArguments: [{ type: "positional", value: "serve" }],
          environmentVariables: [{ name: "ACME_KEY", isRequired: true, isSecret: true }],
        },
      ],
    });
    expect(e).toMatchObject({
      id: "com.acme-mcp",
      name: "Acme",
      source: "registry",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@acme/mcp@1.2.3", "serve"],
      env: { ACME_KEY: "{{env_ACME_KEY}}" },
      configFields: [{ key: "env_ACME_KEY", label: "ACME_KEY", required: true, secret: true }],
    });
  });

  it("maps pypi to uvx and remotes with header fields", () => {
    expect(
      mapRegistryServer({ name: "a/b", description: "d", packages: [{ registryType: "pypi", identifier: "foo", version: "2", transport: { type: "stdio" } }] }),
    ).toMatchObject({ command: "uvx", args: ["foo==2"] });
    const r = mapRegistryServer({
      name: "a/c",
      description: "d",
      remotes: [{ type: "streamable-http", url: "https://x/mcp", headers: [{ name: "Authorization", isSecret: true, isRequired: true }] }],
    });
    expect(r).toMatchObject({
      transport: "http",
      url: "https://x/mcp",
      headers: { Authorization: "{{header_Authorization}}" },
      configFields: [{ key: "header_Authorization", required: true, secret: true }],
    });
  });

  it("skips unsupported / templated servers", () => {
    expect(mapRegistryServer({ name: "a/d", description: "d", packages: [{ registryType: "oci", identifier: "x", transport: { type: "stdio" } }] })).toBeNull();
    expect(mapRegistryServer({ name: "a/e", description: "d", remotes: [{ type: "streamable-http", url: "https://{tenant}.x/mcp" }] })).toBeNull();
    expect(mapRegistryServer({ name: "a/f" })).toBeNull();
  });

  it("sanitizes ids", () => {
    expect(registryEntryId("io.github.foo/bar baz")).toBe("io.github.foo-bar-baz");
  });
});

describe("fetchRegistryEntries", () => {
  const server = { server: { name: "a/b", description: "d", remotes: [{ type: "sse", url: "https://x/sse" }] } };

  it("pages, maps, and caches", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(jsonRes({ servers: [server], metadata: { nextCursor: "c1" } }))
      .mockResolvedValueOnce(jsonRes({ servers: [server] }));
    _setRegistryFetch(f as never);
    const r = await fetchRegistryEntries();
    expect(r.entries).toHaveLength(1);
    expect(f).toHaveBeenCalledTimes(2);
    await fetchRegistryEntries();
    expect(f).toHaveBeenCalledTimes(2); // cached
  });

  it("never throws: returns error + empty on failure", async () => {
    _setRegistryFetch((async () => jsonRes({}, false, 503)) as never);
    const r = await fetchRegistryEntries();
    expect(r.entries).toEqual([]);
    expect(r.error).toMatch(/503/);
    _setRegistryFetch((async () => { throw new Error("offline"); }) as never);
    expect((await fetchRegistryEntries()).error).toBe("offline");
  });
});
