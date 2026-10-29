import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-updater", () => ({
  autoUpdater: { on: vi.fn(), checkForUpdates: vi.fn(), quitAndInstall: vi.fn() },
}));

import { isReleaseAssetsPendingError } from "./updater";

describe("isReleaseAssetsPendingError", () => {
  it("matches the 404 for a not-yet-uploaded latest.yml", () => {
    expect(
      isReleaseAssetsPendingError(
        "Cannot find latest.yml in the latest release artifacts (https://github.com/o/r/releases/download/v1.1.0/latest.yml): HttpError: 404",
      ),
    ).toBe(true);
  });

  it("matches the mac/linux manifests", () => {
    expect(isReleaseAssetsPendingError("Cannot find latest-mac.yml in the latest release artifacts (x)")).toBe(true);
    expect(isReleaseAssetsPendingError("Cannot find latest-linux.yml in the latest release artifacts (x)")).toBe(true);
  });

  it("does not swallow unrelated errors", () => {
    expect(isReleaseAssetsPendingError("net::ERR_INTERNET_DISCONNECTED")).toBe(false);
  });
});
