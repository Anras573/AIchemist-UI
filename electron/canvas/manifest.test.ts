import { describe, expect, it } from "vitest";
import { parseCanvasManifest } from "./manifest";

const VALID_MANIFEST = {
  name: "kanban",
  description: "A kanban board",
  version: 1,
  server: "server.mjs",
  ui: "ui/index.html",
};

describe("parseCanvasManifest", () => {
  it("accepts a minimal valid manifest, defaulting description to empty string", () => {
    const result = parseCanvasManifest({
      name: "kanban",
      version: 1,
      server: "server.mjs",
      ui: "ui/index.html",
    });
    expect(result).toEqual({
      success: true,
      manifest: {
        name: "kanban",
        description: "",
        version: 1,
        server: "server.mjs",
        ui: "ui/index.html",
      },
    });
  });

  it("accepts a full manifest with attachByDefault and permissions", () => {
    const result = parseCanvasManifest({
      ...VALID_MANIFEST,
      attachByDefault: true,
      permissions: { fs: ["${project}"], network: ["api.github.com"], exec: ["git"] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.manifest.attachByDefault).toBe(true);
      expect(result.manifest.permissions).toEqual({
        fs: ["${project}"],
        network: ["api.github.com"],
        exec: ["git"],
      });
    }
  });

  it("accepts permissions with only some keys present", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, permissions: { exec: ["git"] } });
    expect(result.success).toBe(true);
  });

  it("rejects a missing name", () => {
    const { name: _name, ...rest } = VALID_MANIFEST;
    const result = parseCanvasManifest(rest);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("name");
  });

  it("rejects an empty name", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects a non-integer version", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, version: 1.5 });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("version");
  });

  it("rejects a zero or negative version", () => {
    expect(parseCanvasManifest({ ...VALID_MANIFEST, version: 0 }).success).toBe(false);
    expect(parseCanvasManifest({ ...VALID_MANIFEST, version: -1 }).success).toBe(false);
  });

  it("rejects a missing server path", () => {
    const { server: _server, ...rest } = VALID_MANIFEST;
    expect(parseCanvasManifest(rest).success).toBe(false);
  });

  it("rejects a missing ui path", () => {
    const { ui: _ui, ...rest } = VALID_MANIFEST;
    expect(parseCanvasManifest(rest).success).toBe(false);
  });

  it("rejects a server path other than the one the runtime resolves", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, server: "main.mjs" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("server.mjs");
  });

  it("rejects a path-traversal or absolute server value", () => {
    expect(parseCanvasManifest({ ...VALID_MANIFEST, server: "../../etc/server.mjs" }).success).toBe(false);
    expect(parseCanvasManifest({ ...VALID_MANIFEST, server: "/etc/server.mjs" }).success).toBe(false);
  });

  it("rejects a ui path other than the one the runtime resolves", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, ui: "ui/main.html" });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toContain("ui/index.html");
  });

  it("rejects permissions with a non-array value", () => {
    const result = parseCanvasManifest({ ...VALID_MANIFEST, permissions: { fs: "everything" } });
    expect(result.success).toBe(false);
  });

  it("rejects a non-object payload", () => {
    expect(parseCanvasManifest(null).success).toBe(false);
    expect(parseCanvasManifest("kanban").success).toBe(false);
    expect(parseCanvasManifest(42).success).toBe(false);
    expect(parseCanvasManifest([]).success).toBe(false);
  });

  it("reports every failing field in the reason string", () => {
    const result = parseCanvasManifest({ name: "", version: -1 });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toContain("name");
      expect(result.reason).toContain("version");
      expect(result.reason).toContain("server");
      expect(result.reason).toContain("ui");
    }
  });
});
