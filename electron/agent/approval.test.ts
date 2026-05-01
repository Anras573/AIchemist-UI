// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  needsApproval,
  requestApproval,
  resolveApproval,
  cancelSessionApprovals,
  computeFingerprint,
  addToSessionAllowlist,
  isSessionAllowed,
  isProjectAllowed,
  requiresApproval,
  getPendingApprovalData,
  requestPermissionChoice,
  resolvePermissionChoice,
} from "./approval";
import type { ProjectConfig } from "../../src/types/index";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeConfig(
  approval_mode: ProjectConfig["approval_mode"],
  approval_rules: ProjectConfig["approval_rules"] = [],
  allowed_tools: ProjectConfig["allowed_tools"] = []
): ProjectConfig {
  return {
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    approval_mode,
    approval_rules,
    custom_tools: [],
    allowed_tools,
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

// ── computeFingerprint ────────────────────────────────────────────────────────

describe("computeFingerprint", () => {
  it("returns tool name for non-bash tools", () => {
    expect(computeFingerprint("write_file", { path: "/tmp/a.txt" })).toBe("write_file");
    expect(computeFingerprint("web_fetch", { url: "https://example.com" })).toBe("web_fetch");
    expect(computeFingerprint("delete_file", {})).toBe("delete_file");
  });

  it("returns execute_bash:<first-word> for bash commands", () => {
    expect(computeFingerprint("execute_bash", { command: "mkdir -p /tmp/foo" })).toBe("execute_bash:mkdir");
    expect(computeFingerprint("execute_bash", { command: "git status" })).toBe("execute_bash:git");
    expect(computeFingerprint("execute_bash", { command: "npm install" })).toBe("execute_bash:npm");
  });

  it("strips leading whitespace before extracting the first word", () => {
    expect(computeFingerprint("execute_bash", { command: "  ls -la" })).toBe("execute_bash:ls");
  });

  it("returns execute_bash: for an empty command", () => {
    expect(computeFingerprint("execute_bash", { command: "" })).toBe("execute_bash:");
    expect(computeFingerprint("execute_bash", {})).toBe("execute_bash:");
  });
});

// ── session allowlist ─────────────────────────────────────────────────────────

describe("session allowlist", () => {
  // The module-level map persists between tests; use unique session IDs to isolate.
  let sid: string;
  beforeEach(() => { sid = `sess-${Math.random()}`; });

  it("returns false when nothing has been added", () => {
    expect(isSessionAllowed(sid, "write_file", {})).toBe(false);
  });

  it("returns true after the exact tool is added", () => {
    addToSessionAllowlist(sid, "write_file", { path: "/tmp/a.txt" });
    expect(isSessionAllowed(sid, "write_file", { path: "/other/path.txt" })).toBe(true);
  });

  it("matches execute_bash by first word, ignoring remaining args", () => {
    addToSessionAllowlist(sid, "execute_bash", { command: "mkdir -p /first" });
    expect(isSessionAllowed(sid, "execute_bash", { command: "mkdir /second" })).toBe(true);
    expect(isSessionAllowed(sid, "execute_bash", { command: "rm -rf /" })).toBe(false);
  });

  it("is scoped to its session ID — does not bleed into other sessions", () => {
    const other = `sess-other-${Math.random()}`;
    addToSessionAllowlist(sid, "write_file", {});
    expect(isSessionAllowed(other, "write_file", {})).toBe(false);
  });

  it("can hold multiple tools for the same session", () => {
    addToSessionAllowlist(sid, "write_file", {});
    addToSessionAllowlist(sid, "web_fetch", {});
    expect(isSessionAllowed(sid, "write_file", {})).toBe(true);
    expect(isSessionAllowed(sid, "web_fetch", {})).toBe(true);
    expect(isSessionAllowed(sid, "delete_file", {})).toBe(false);
  });
});

// ── isProjectAllowed ──────────────────────────────────────────────────────────

describe("isProjectAllowed", () => {
  function cfg(allowed_tools: ProjectConfig["allowed_tools"]): ProjectConfig {
    return makeConfig("custom", [], allowed_tools);
  }

  it("returns false when allowed_tools is empty", () => {
    expect(isProjectAllowed(cfg([]), "write_file", {})).toBe(false);
  });

  it("returns true for an exact tool_name match with no pattern", () => {
    expect(isProjectAllowed(cfg([{ tool_name: "write_file" }]), "write_file", {})).toBe(true);
  });

  it("returns false when tool_name does not match", () => {
    expect(isProjectAllowed(cfg([{ tool_name: "web_fetch" }]), "write_file", {})).toBe(false);
  });

  it("matches execute_bash when command starts with the pattern", () => {
    const config = cfg([{ tool_name: "execute_bash", command_pattern: "mkdir" }]);
    expect(isProjectAllowed(config, "execute_bash", { command: "mkdir -p /tmp/foo" })).toBe(true);
    expect(isProjectAllowed(config, "execute_bash", { command: "mkdir /bar" })).toBe(true);
  });

  it("does not match execute_bash when command does not start with the pattern", () => {
    const config = cfg([{ tool_name: "execute_bash", command_pattern: "mkdir" }]);
    expect(isProjectAllowed(config, "execute_bash", { command: "rm -rf /" })).toBe(false);
    expect(isProjectAllowed(config, "execute_bash", { command: "git commit" })).toBe(false);
  });

  it("treats undefined command_pattern as allow-all for that tool", () => {
    const config = cfg([{ tool_name: "execute_bash" }]);
    expect(isProjectAllowed(config, "execute_bash", { command: "rm -rf /" })).toBe(true);
  });

  it("gracefully handles missing allowed_tools field (legacy configs)", () => {
    const config = makeConfig("custom") as ProjectConfig;
    // @ts-expect-error intentionally testing missing field
    delete config.allowed_tools;
    expect(isProjectAllowed(config, "write_file", {})).toBe(false);
  });
});

// ── requiresApproval ─────────────────────────────────────────────────────────

describe("requiresApproval", () => {
  let sid: string;
  beforeEach(() => { sid = `sess-req-${Math.random()}`; });

  it("returns true when nothing is allowlisted and category requires approval", () => {
    const config = makeConfig("all");
    expect(requiresApproval(sid, config, "filesystem", "write_file", {})).toBe(true);
  });

  it("returns false when tool is in the session allowlist", () => {
    const config = makeConfig("all"); // would normally require approval
    addToSessionAllowlist(sid, "write_file", {});
    expect(requiresApproval(sid, config, "filesystem", "write_file", {})).toBe(false);
  });

  it("returns false when tool matches project allowed_tools", () => {
    const config = makeConfig("all", [], [{ tool_name: "write_file" }]);
    expect(requiresApproval(sid, config, "filesystem", "write_file", {})).toBe(false);
  });

  it("session allowlist takes priority over category rules", () => {
    const config = makeConfig("custom", [{ tool_category: "shell", policy: "always" }]);
    addToSessionAllowlist(sid, "execute_bash", { command: "git status" });
    expect(requiresApproval(sid, config, "shell", "execute_bash", { command: "git status" })).toBe(false);
  });

  it("falls through to needsApproval when neither allowlist matches", () => {
    const config = makeConfig("none");
    expect(requiresApproval(sid, config, "filesystem", "write_file", {})).toBe(false);

    const configAll = makeConfig("all");
    expect(requiresApproval(sid, configAll, "filesystem", "write_file", {})).toBe(true);
  });
});

// ── getPendingApprovalData ────────────────────────────────────────────────────

describe("getPendingApprovalData", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null for an unknown approvalId", () => {
    expect(getPendingApprovalData("unknown-id")).toBeNull();
  });

  it("returns the stored toolName and args for a pending approval", () => {
    const wc = makeWebContents();
    const args = { command: "ls -la" };
    requestApproval(wc, "sess-1", "execute_bash", args);

    const approvalId = vi.mocked(wc.send).mock.calls[0][1].approval_id;
    const data = getPendingApprovalData(approvalId);

    expect(data).not.toBeNull();
    expect(data!.sessionId).toBe("sess-1");
    expect(data!.toolName).toBe("execute_bash");
    expect(data!.args).toEqual(args);
  });

  it("returns null after the approval has been resolved (consumed)", async () => {
    const wc = makeWebContents();
    const promise = requestApproval(wc, "sess-1", "write_file", {});
    const approvalId = vi.mocked(wc.send).mock.calls[0][1].approval_id;

    resolveApproval(approvalId, true);
    await promise;

    expect(getPendingApprovalData(approvalId)).toBeNull();
  });
});

// ── cancelSessionApprovals ────────────────────────────────────────────────────

describe("cancelSessionApprovals", () => {
  beforeEach(() => vi.clearAllMocks());

  it("auto-denies all pending approvals for the given session", async () => {
    const wc = makeWebContents();
    const p1 = requestApproval(wc, "sess-cancel", "write_file", {});
    const p2 = requestApproval(wc, "sess-cancel", "execute_bash", { command: "ls" });

    cancelSessionApprovals("sess-cancel");

    await expect(p1).resolves.toBe(false);
    await expect(p2).resolves.toBe(false);
  });

  it("does not affect approvals for a different session", async () => {
    const wc = makeWebContents();
    const kept = requestApproval(wc, "sess-other", "write_file", {});
    const cancelled = requestApproval(wc, "sess-cancel2", "write_file", {});

    cancelSessionApprovals("sess-cancel2");
    await expect(cancelled).resolves.toBe(false);

    // Resolve the kept one normally — should still work
    const keptId = vi.mocked(wc.send).mock.calls[0][1].approval_id;
    resolveApproval(keptId, true);
    await expect(kept).resolves.toBe(true);
  });

  it("clears the session allowlist entries for the cancelled session", () => {
    addToSessionAllowlist("sess-acl", "write_file", {});
    expect(isSessionAllowed("sess-acl", "write_file", {})).toBe(true);

    cancelSessionApprovals("sess-acl");

    expect(isSessionAllowed("sess-acl", "write_file", {})).toBe(false);
  });

  it("is a no-op when there are no pending approvals for the session", () => {
    expect(() => cancelSessionApprovals("sess-nonexistent")).not.toThrow();
  });
});

// ── Option-based approvals (ACP) ─────────────────────────────────────────────

describe("requestPermissionChoice / resolvePermissionChoice", () => {
  it("emits SESSION_APPROVAL_REQUIRED with permission_options and resolves with chosen optionId", async () => {
    const wc = makeWebContents();
    const promise = requestPermissionChoice(wc, "sess-1", "tc-1", "fs_write", { path: "/x" }, [
      { id: "opt-allow", name: "Allow", kind: "allow_once" },
      { id: "opt-deny", name: "Deny", kind: "reject_once" },
    ]);
    expect(wc.send).toHaveBeenCalledTimes(1);
    const [, payload] = (wc.send as any).mock.calls[0];
    expect(payload.permission_options).toHaveLength(2);
    expect(payload.tool_call_id).toBe("tc-1");
    resolvePermissionChoice(payload.approval_id, "opt-allow");
    await expect(promise).resolves.toBe("opt-allow");
  });

  it("resolves with null when cancelled", async () => {
    const wc = makeWebContents();
    const promise = requestPermissionChoice(wc, "sess-2", "tc", "fs_write", {}, [
      { id: "x", name: "X", kind: "allow_once" },
    ]);
    const id = (wc.send as any).mock.calls[0][1].approval_id;
    resolvePermissionChoice(id, null);
    await expect(promise).resolves.toBeNull();
  });

  it("resolveApproval refuses to fabricate optionId for option-based approvals", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const wc = makeWebContents();
    const promise = requestPermissionChoice(wc, "sess-3", "tc", "fs_write", {}, [
      { id: "x", name: "X", kind: "allow_once" },
    ]);
    const id = (wc.send as any).mock.calls[0][1].approval_id;
    // Misuse: caller hits boolean resolveApproval on an option-based id.
    resolveApproval(id, true);
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).toMatch(/option-based/);
    // Promise must NOT resolve — eventually cleaned up via cancelSessionApprovals.
    cancelSessionApprovals("sess-3");
    await expect(promise).resolves.toBeNull();
    warn.mockRestore();
  });

  it("cancelSessionApprovals cancels pending choice approvals for the session", async () => {
    const wc = makeWebContents();
    const promise = requestPermissionChoice(wc, "sess-4", "tc", "fs_write", {}, [
      { id: "x", name: "X", kind: "allow_once" },
    ]);
    cancelSessionApprovals("sess-4");
    await expect(promise).resolves.toBeNull();
  });

  it("getPendingApprovalData finds option-based approvals too", () => {
    const wc = makeWebContents();
    requestPermissionChoice(wc, "sess-5", "tc-z", "fs_write", { path: "/y" }, [
      { id: "a", name: "A", kind: "allow_once" },
    ]);
    const id = (wc.send as any).mock.calls[0][1].approval_id;
    const data = getPendingApprovalData(id);
    expect(data).toEqual({ sessionId: "sess-5", toolName: "fs_write", args: { path: "/y" } });
    cancelSessionApprovals("sess-5");
  });
});
