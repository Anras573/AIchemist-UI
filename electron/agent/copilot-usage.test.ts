// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getApiKeyMock, getQuotaMock } = vi.hoisted(() => ({
  getApiKeyMock: vi.fn<(provider: string) => string | null>(),
  getQuotaMock: vi.fn(),
}));

vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  getApiKey: getApiKeyMock,
}));
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: vi.fn().mockImplementation(function () {
    return {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      rpc: { account: { getQuota: getQuotaMock } },
    };
  }),
}));

import { addPremiumRequests, getCopilotQuota, stopCopilotClient } from "./copilot";

describe("addPremiumRequests", () => {
  it("sums the cost multiplier of user-initiated calls", () => {
    let running: number | null = null;
    running = addPremiumRequests(running, { cost: 1 });
    running = addPremiumRequests(running, { cost: 0.33 });
    expect(running).toBeCloseTo(1.33);
  });

  it("ignores sub-agent / sampling calls, BYOK calls, and calls without a cost", () => {
    expect(addPremiumRequests(null, { cost: 1, initiator: "sub-agent" })).toBeNull();
    expect(addPremiumRequests(null, { cost: 1, isByok: true })).toBeNull();
    expect(addPremiumRequests(null, {})).toBeNull();
    expect(addPremiumRequests(2, { cost: Number.NaN })).toBe(2);
  });

  it("counts a zero-multiplier (included) model as 0 rather than unreported", () => {
    expect(addPremiumRequests(null, { cost: 0 })).toBe(0);
  });
});

describe("getCopilotQuota", () => {
  beforeEach(() => {
    getApiKeyMock.mockReturnValue("ghp_test");
  });

  afterEach(async () => {
    await stopCopilotClient();
    vi.clearAllMocks();
  });

  it("reports not-configured without starting the client when there's no GitHub token", async () => {
    getApiKeyMock.mockReturnValue(null);
    expect(await getCopilotQuota()).toEqual({ ok: false, reason: "GITHUB_TOKEN is not configured" });
    expect(getQuotaMock).not.toHaveBeenCalled();
  });

  it("maps the SDK's quota snapshots", async () => {
    getQuotaMock.mockResolvedValue({
      quotaSnapshots: {
        premium_interactions: {
          isUnlimitedEntitlement: false,
          entitlementRequests: 300,
          usedRequests: 120,
          remainingPercentage: 60,
          overage: 0,
          overageAllowedWithExhaustedQuota: true,
          usageAllowedWithExhaustedQuota: false,
          resetDate: "2026-12-01T00:00:00Z",
        },
        chat: undefined,
      },
    });

    expect(await getCopilotQuota()).toEqual({
      ok: true,
      snapshots: [
        {
          key: "premium_interactions",
          unlimited: false,
          entitlement: 300,
          used: 120,
          remainingPercentage: 60,
          overage: 0,
          resetDate: "2026-12-01T00:00:00Z",
        },
      ],
    });
  });

  it("never throws — an RPC failure resolves ok: false with the reason", async () => {
    getQuotaMock.mockRejectedValue(new Error("not supported"));
    expect(await getCopilotQuota()).toEqual({ ok: false, reason: "not supported" });
  });
});
