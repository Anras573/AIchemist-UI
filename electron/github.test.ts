// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildGitPath, getRemoteInfo, parseGitHubRemoteUrl } from "./github";

describe("parseGitHubRemoteUrl", () => {
  it("parses HTTPS remotes with .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/octo-org/example-repo.git")).toEqual({
      owner: "octo-org",
      repo: "example-repo",
    });
  });

  it("parses HTTPS remotes without .git suffix", () => {
    expect(parseGitHubRemoteUrl("https://github.com/octo-org/example-repo")).toEqual({
      owner: "octo-org",
      repo: "example-repo",
    });
  });

  it("parses SSH remotes", () => {
    expect(parseGitHubRemoteUrl("git@github.com:octo-org/example-repo.git")).toEqual({
      owner: "octo-org",
      repo: "example-repo",
    });
  });

  it("parses ssh:// remotes", () => {
    expect(parseGitHubRemoteUrl("ssh://git@github.com/octo-org/example-repo.git")).toEqual({
      owner: "octo-org",
      repo: "example-repo",
    });
  });

  it("returns null for non-GitHub remotes", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/octo-org/example-repo.git")).toBeNull();
  });

  it("returns null for malformed repository paths", () => {
    expect(parseGitHubRemoteUrl("https://github.com/octo-org/example-repo/extra")).toBeNull();
    expect(parseGitHubRemoteUrl("git@github.com:octo-org")).toBeNull();
  });
});

describe("getRemoteInfo", () => {
  it("returns parsed owner/repo from origin remote", async () => {
    const result = await getRemoteInfo(
      "/tmp/project",
      async () => "git@github.com:octo-org/example-repo.git"
    );

    expect(result).toEqual({ owner: "octo-org", repo: "example-repo" });
  });

  it("returns null when origin remote lookup fails", async () => {
    const result = await getRemoteInfo("/tmp/project", async () => {
      throw new Error("origin not found");
    });

    expect(result).toBeNull();
  });

  it("returns null when origin remote is not GitHub", async () => {
    const result = await getRemoteInfo(
      "/tmp/project",
      async () => "https://gitlab.com/octo-org/example-repo.git"
    );

    expect(result).toBeNull();
  });
});

describe("buildGitPath", () => {
  it("uses Unix delimiter when provided", () => {
    expect(buildGitPath("/bin:/usr/bin", ":")).toBe(
      "/usr/bin:/usr/local/bin:/opt/homebrew/bin:/bin:/usr/bin"
    );
  });

  it("uses Windows delimiter when provided", () => {
    expect(buildGitPath("C:\\Windows\\System32;C:\\Program Files\\Git\\cmd", ";")).toBe(
      "/usr/bin;/usr/local/bin;/opt/homebrew/bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd"
    );
  });
});
