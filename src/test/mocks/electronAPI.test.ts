import { describe, expect, it, vi } from "vitest";
import { createElectronAPIMock } from "./electronAPI";

describe("createElectronAPIMock", () => {
  it("returns missing-token error for GitHub IPC methods by default", async () => {
    const api = createElectronAPIMock();
    const expected = { error: "GITHUB_TOKEN not configured" };

    await expect(
      api.githubCreatePr({ projectPath: "/repo", title: "Test PR" })
    ).resolves.toEqual(expected);
    await expect(
      api.githubListPrs({ projectPath: "/repo" })
    ).resolves.toEqual(expected);
    await expect(
      api.githubListIssues({ projectPath: "/repo" })
    ).resolves.toEqual(expected);
    await expect(
      api.githubGetCiStatus({ projectPath: "/repo" })
    ).resolves.toEqual(expected);
  });

  it("returns not-implemented when GitHub token is configured", async () => {
    const api = createElectronAPIMock();
    vi.mocked(api.getApiKey).mockResolvedValue("token");

    await expect(
      api.githubListPrs({ projectPath: "/repo" })
    ).resolves.toEqual({ error: "not implemented" });
  });
});
