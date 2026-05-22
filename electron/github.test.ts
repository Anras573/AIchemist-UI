// @vitest-environment node
import { describe, it, expect } from "vitest";
import { getRemoteInfo, parseGitHubRemoteUrl } from "./github";

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
  it("returns parsed owner/repo from origin remote", () => {
    const result = getRemoteInfo(
      "/tmp/project",
      () => "git@github.com:octo-org/example-repo.git"
    );

    expect(result).toEqual({ owner: "octo-org", repo: "example-repo" });
  });

  it("returns null when origin remote lookup fails", () => {
    const result = getRemoteInfo("/tmp/project", () => {
      throw new Error("origin not found");
    });

    expect(result).toBeNull();
  });

  it("returns null when origin remote is not GitHub", () => {
    const result = getRemoteInfo(
      "/tmp/project",
      () => "https://gitlab.com/octo-org/example-repo.git"
    );

    expect(result).toBeNull();
  });
});
