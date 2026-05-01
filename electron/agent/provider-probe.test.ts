// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  probeAnthropic,
  probeCopilot,
  probeAcpForProject,
  probeAll,
  _setFetch,
  _setCopilotListModels,
  _setAcpProbe,
  _resetProviderProbeCache,
} from "./provider-probe";

describe("provider-probe", () => {
  beforeEach(() => {
    _resetProviderProbeCache();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
  });

  afterEach(() => {
    _setFetch(null);
    _setCopilotListModels(null);
    _setAcpProbe(null);
  });

  // ── Anthropic ──────────────────────────────────────────────────────────────

  describe("probeAnthropic", () => {
    it("reports missing credential when no env var and no OAuth file", async () => {
      // Make oauth detection return false by pointing HOME at a temp dir.
      const origHome = process.env.HOME;
      process.env.HOME = "/tmp/__nonexistent_home_for_probe_test__";
      try {
        const result = await probeAnthropic({ force: true });
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/No Anthropic credential/);
      } finally {
        if (origHome !== undefined) process.env.HOME = origHome;
        else delete process.env.HOME;
      }
    });

    it("returns ok when /v1/messages responds 200", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      _setFetch(vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(true);
    });

    it("treats HTTP 400 as ok (auth + URL work, request body just bad)", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      _setFetch(vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(true);
    });

    it("flags 401 as auth rejected", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-bad";
      _setFetch(vi.fn().mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/auth rejected/);
    });

    it("flags 404 as wrong base URL (e.g., proxy doesn't route /v1/messages)", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      _setFetch(vi.fn().mockResolvedValue({ ok: false, status: 404 }) as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/ANTHROPIC_BASE_URL/);
    });

    it("uses Authorization: Bearer when only ANTHROPIC_AUTH_TOKEN is set", async () => {
      process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      _setFetch(fetchSpy as unknown as typeof fetch);
      await probeAnthropic({ force: true });
      const init = fetchSpy.mock.calls[0]![1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer oauth-token");
      expect(headers["x-api-key"]).toBeUndefined();
    });

    it("falls back to Authorization: Bearer when x-api-key returns 401 and ANTHROPIC_AUTH_TOKEN is set", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.ANTHROPIC_AUTH_TOKEN = "oauth-token";
      const fetchSpy = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 401 })
        .mockResolvedValueOnce({ ok: false, status: 406 });
      _setFetch(fetchSpy as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const second = fetchSpy.mock.calls[1]![1] as RequestInit;
      expect((second.headers as Record<string, string>)["Authorization"]).toBe("Bearer oauth-token");
    });

    it("returns network errors as not-ok", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      _setFetch(vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch);
      const result = await probeAnthropic({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/ENOTFOUND/);
    });

    it("caches the result and serves from cache without refetching", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      _setFetch(fetchSpy as unknown as typeof fetch);
      await probeAnthropic({ force: true });
      await probeAnthropic();
      await probeAnthropic();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("force: true bypasses the cache", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      _setFetch(fetchSpy as unknown as typeof fetch);
      await probeAnthropic({ force: true });
      await probeAnthropic({ force: true });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it("respects ANTHROPIC_BASE_URL override and probes /v1/messages", async () => {
      process.env.ANTHROPIC_API_KEY = "sk-test";
      process.env.ANTHROPIC_BASE_URL = "https://proxy.example.com/";
      const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      _setFetch(fetchSpy as unknown as typeof fetch);
      await probeAnthropic({ force: true });
      const calledUrl = fetchSpy.mock.calls[0]![0] as string;
      expect(calledUrl).toBe("https://proxy.example.com/v1/messages");
    });
  });

  // ── Copilot ────────────────────────────────────────────────────────────────

  describe("probeCopilot", () => {
    it("reports missing token when GITHUB_TOKEN is unset", async () => {
      const result = await probeCopilot({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/GITHUB_TOKEN/);
    });

    it("returns ok when SDK lists at least one model", async () => {
      process.env.GITHUB_TOKEN = "ghp-test";
      _setCopilotListModels(async () => [{ id: "gpt-4o", name: "GPT-4o" }]);
      const result = await probeCopilot({ force: true });
      expect(result.ok).toBe(true);
    });

    it("returns not ok when SDK returns an empty array", async () => {
      process.env.GITHUB_TOKEN = "ghp-test";
      _setCopilotListModels(async () => []);
      const result = await probeCopilot({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/no models/i);
    });

    it("surfaces SDK exceptions", async () => {
      process.env.GITHUB_TOKEN = "ghp-test";
      _setCopilotListModels(async () => {
        throw new Error("auth boom");
      });
      const result = await probeCopilot({ force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/auth boom/);
    });
  });

  // ── ACP ────────────────────────────────────────────────────────────────────

  describe("probeAcpForProject", () => {
    it("reports missing config when acp_agent is absent", async () => {
      const result = await probeAcpForProject("/proj", {} as never, { force: true });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/not configured/);
    });

    it("delegates to acpProbe and caches the result", async () => {
      const probeSpy = vi.fn().mockResolvedValue({ ok: true });
      _setAcpProbe(probeSpy);
      const cfg = ({
        provider: "acp",
        model: "",
        approval_policy: "manual" as const,
        approval_rules: [],
        acp_agent: { command: "/bin/echo" },
      } as unknown as import("../../src/types/index").ProjectConfig);
      const r1 = await probeAcpForProject("/proj", cfg, { force: true });
      const r2 = await probeAcpForProject("/proj", cfg);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(probeSpy).toHaveBeenCalledTimes(1);
    });

    it("invalidates the cache when acp_agent fingerprint changes", async () => {
      const probeSpy = vi.fn().mockResolvedValue({ ok: true });
      _setAcpProbe(probeSpy);
      const base = {
        provider: "acp",
        model: "",
        approval_policy: "manual" as const,
        approval_rules: [],
      } as unknown as import("../../src/types/index").ProjectConfig;
      await probeAcpForProject("/proj", { ...base, acp_agent: { command: "/bin/a" } }, { force: true });
      await probeAcpForProject("/proj", { ...base, acp_agent: { command: "/bin/b" } });
      expect(probeSpy).toHaveBeenCalledTimes(2);
    });

    it("surfaces acpProbe failure reason", async () => {
      _setAcpProbe(async () => ({ ok: false, reason: "ENOENT" }));
      const cfg = ({
        provider: "acp",
        model: "",
        approval_policy: "manual" as const,
        approval_rules: [],
        acp_agent: { command: "/missing" },
      } as unknown as import("../../src/types/index").ProjectConfig);
      const r = await probeAcpForProject("/proj", cfg, { force: true });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe("ENOENT");
    });
  });

  // ── probeAll ───────────────────────────────────────────────────────────────

  describe("probeAll", () => {
    it("returns anthropic + copilot only when no project is supplied", async () => {
      _setFetch(vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch);
      _setCopilotListModels(async () => [{ id: "x", name: "x" }]);
      process.env.ANTHROPIC_API_KEY = "sk";
      process.env.GITHUB_TOKEN = "gh";
      const r = await probeAll(undefined, { force: true });
      expect(r.anthropic.ok).toBe(true);
      expect(r.copilot.ok).toBe(true);
      expect(r.acp).toBeUndefined();
    });

    it("includes acp when a project is supplied", async () => {
      _setFetch(vi.fn().mockResolvedValue({ ok: true, status: 200 }) as unknown as typeof fetch);
      _setCopilotListModels(async () => [{ id: "x", name: "x" }]);
      _setAcpProbe(async () => ({ ok: true }));
      process.env.ANTHROPIC_API_KEY = "sk";
      process.env.GITHUB_TOKEN = "gh";
      const r = await probeAll(
        {
          path: "/proj",
          config: {
            provider: "acp",
            model: "",
            approval_policy: "manual",
            approval_rules: [],
            acp_agent: { command: "/x" },
          } as unknown as import("../../src/types/index").ProjectConfig,
        },
        { force: true },
      );
      expect(r.acp?.ok).toBe(true);
    });
  });
});
