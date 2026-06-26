import { describe, expect, it } from "vitest";
import { codexProvider } from "./codex";

describe("codexProvider", () => {
  it("returns a user-facing unavailable message instead of throwing", async () => {
    const params = {} as Parameters<typeof codexProvider.run>[0];
    await expect(codexProvider.run(params)).resolves.toMatch(/not available yet/i);
  });

  it("reports codex as unavailable in provider probes", async () => {
    await expect(codexProvider.probe?.()).resolves.toEqual({
      ok: false,
      reason: "Codex provider is not configured or implemented yet.",
    });
  });
});
