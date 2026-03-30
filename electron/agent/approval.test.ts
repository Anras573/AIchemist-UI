// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { needsApproval, requestApproval, resolveApproval } from "./approval";
import type { ProjectConfig } from "../../src/types/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(
  approval_mode: ProjectConfig["approval_mode"],
  approval_rules: ProjectConfig["approval_rules"] = []
): ProjectConfig {
  return {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    approval_mode,
    approval_rules,
    custom_tools: [],
    allowed_tools: [],
  };
}

function makeWebContents() {
  return { send: vi.fn() } as unknown as Electron.WebContents;
}

// ── needsApproval ─────────────────────────────────────────────────────────────

describe("needsApproval", () => {
  describe("shell category", () => {
    it("always requires approval regardless of mode=none", () => {
      expect(needsApproval(makeConfig("none"), "shell")).toBe(true);
    });

    it("always requires approval regardless of mode=all", () => {
      expect(needsApproval(makeConfig("all"), "shell")).toBe(true);
    });

    it("always requires approval regardless of mode=custom", () => {
      expect(needsApproval(makeConfig("custom"), "shell")).toBe(true);
    });
  });

  describe('mode: "all"', () => {
    it("requires approval for filesystem", () => {
      expect(needsApproval(makeConfig("all"), "filesystem")).toBe(true);
    });

    it("requires approval for web", () => {
      expect(needsApproval(makeConfig("all"), "web")).toBe(true);
    });
  });

  describe('mode: "none"', () => {
    it("does not require approval for filesystem", () => {
      expect(needsApproval(makeConfig("none"), "filesystem")).toBe(false);
    });

    it("does not require approval for web", () => {
      expect(needsApproval(makeConfig("none"), "web")).toBe(false);
    });
  });

  describe('mode: "custom"', () => {
    it('requires approval when the matching rule policy is "always"', () => {
      const config = makeConfig("custom", [
        { tool_category: "filesystem", policy: "always" },
      ]);
      expect(needsApproval(config, "filesystem")).toBe(true);
    });

    it('does not require approval when the matching rule policy is "never"', () => {
      const config = makeConfig("custom", [
        { tool_category: "filesystem", policy: "never" },
      ]);
      expect(needsApproval(config, "filesystem")).toBe(false);
    });

    it("does not require approval when there is no rule for the category", () => {
      const config = makeConfig("custom", []);
      expect(needsApproval(config, "filesystem")).toBe(false);
      expect(needsApproval(config, "web")).toBe(false);
    });

    it("evaluates each category against its own rule, ignoring others", () => {
      const config = makeConfig("custom", [
        { tool_category: "web", policy: "always" },
        { tool_category: "filesystem", policy: "never" },
      ]);
      expect(needsApproval(config, "web")).toBe(true);
      expect(needsApproval(config, "filesystem")).toBe(false);
    });

    it('treats "risky_only" policy the same as no match (falsy)', () => {
      // risky_only is a valid policy value but needsApproval only checks for "always"
      const config = makeConfig("custom", [
        { tool_category: "filesystem", policy: "risky_only" },
      ]);
      expect(needsApproval(config, "filesystem")).toBe(false);
    });
  });
});

// ── requestApproval / resolveApproval ─────────────────────────────────────────

describe("requestApproval / resolveApproval", () => {
  beforeEach(() => vi.clearAllMocks());

  it("emits session:approval_required with the correct payload", () => {
    const wc = makeWebContents();
    requestApproval(wc, "sess-1", "write_file", { path: "/tmp/a.txt" });

    expect(wc.send).toHaveBeenCalledOnce();
    const [channel, payload] = vi.mocked(wc.send).mock.calls[0];
    expect(channel).toBe("session:approval_required");
    expect(payload).toMatchObject({
      session_id: "sess-1",
      tool_name: "write_file",
      input: { path: "/tmp/a.txt" },
    });
    expect(typeof payload.approval_id).toBe("string");
    expect(payload.approval_id.length).toBeGreaterThan(0);
  });

  it("resolves true when the user approves", async () => {
    const wc = makeWebContents();
    const promise = requestApproval(wc, "sess-1", "write_file", {});

    const approvalId = vi.mocked(wc.send).mock.calls[0][1].approval_id;
    resolveApproval(approvalId, true);

    await expect(promise).resolves.toBe(true);
  });

  it("resolves false when the user denies", async () => {
    const wc = makeWebContents();
    const promise = requestApproval(wc, "sess-2", "execute_bash", { command: "rm -rf /" });

    const approvalId = vi.mocked(wc.send).mock.calls[0][1].approval_id;
    resolveApproval(approvalId, false);

    await expect(promise).resolves.toBe(false);
  });

  it("is a no-op when called with an unknown approval ID", () => {
    expect(() => resolveApproval("non-existent-id", true)).not.toThrow();
  });

  it("resolves each pending approval independently when multiple are open", async () => {
    const wc = makeWebContents();
    const p1 = requestApproval(wc, "sess-1", "tool-a", {});
    const p2 = requestApproval(wc, "sess-2", "tool-b", {});

    const id1 = vi.mocked(wc.send).mock.calls[0][1].approval_id;
    const id2 = vi.mocked(wc.send).mock.calls[1][1].approval_id;

    // Resolve in reverse order to confirm they are tracked independently
    resolveApproval(id2, false);
    resolveApproval(id1, true);

    await expect(p1).resolves.toBe(true);
    await expect(p2).resolves.toBe(false);
  });

  it("does not resolve a second time after the approval has already been consumed", async () => {
    const wc = makeWebContents();
    const promise = requestApproval(wc, "sess-1", "write_file", {});
    const approvalId = vi.mocked(wc.send).mock.calls[0][1].approval_id;

    resolveApproval(approvalId, true);
    await expect(promise).resolves.toBe(true);

    // Second call with same ID should be a no-op (entry was already deleted)
    expect(() => resolveApproval(approvalId, false)).not.toThrow();
  });
});
