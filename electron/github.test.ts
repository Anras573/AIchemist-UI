// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  getRemoteInfo,
  parseGitHubRemoteUrl,
  aggregateCiStatus,
  listPullRequests,
  listIssues,
  createPullRequest,
  getCiStatus,
} from "./github";
import type { GitHubRemoteInfo, OctokitClient, GitHubTestDeps } from "./github";

// ─── Shared test data ─────────────────────────────────────────────────────────

const REMOTE: GitHubRemoteInfo = { owner: "octo-org", repo: "example-repo" };
const PROJECT_PATH = "/tmp/project";

/** Builds a minimal Octokit mock. Override individual methods per test. */
function makeOctokitMock(overrides?: Partial<OctokitClient>): OctokitClient {
  const base: OctokitClient = {
    pulls: {
      list: async () => ({ data: [] }),
      create: async () => ({ data: {} }),
      get: async () => ({ data: { head: { sha: "abc123", ref: "feature" }, base: { ref: "main" } } }),
    },
    issues: {
      listForRepo: async () => ({ data: [] }),
    },
    checks: {
      listForRef: async () => ({ data: { check_runs: [] } }),
    },
    repos: {
      get: async () => ({ data: { default_branch: "main" } }),
    },
  } as unknown as OctokitClient;

  return overrides ? { ...base, ...overrides } as OctokitClient : base;
}

/** Deps that always supply a valid remote + client. */
function happyDeps(clientOverrides?: Partial<OctokitClient>): GitHubTestDeps {
  return { remoteInfo: REMOTE, client: makeOctokitMock(clientOverrides) };
}

/** Simulates an Octokit RequestError with the given HTTP status. */
function makeHttpError(status: number, message = "error"): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

// ─── parseGitHubRemoteUrl ─────────────────────────────────────────────────────

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

// ─── getRemoteInfo ────────────────────────────────────────────────────────────

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

// ─── aggregateCiStatus ────────────────────────────────────────────────────────

describe("aggregateCiStatus", () => {
  it("returns unknown for empty check runs", () => {
    expect(aggregateCiStatus([])).toBe("unknown");
  });

  it("returns success when all runs completed successfully", () => {
    expect(
      aggregateCiStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "neutral" },
        { status: "completed", conclusion: "skipped" },
      ])
    ).toBe("success");
  });

  it("returns failure when any run has a failed conclusion", () => {
    expect(
      aggregateCiStatus([
        { status: "completed", conclusion: "success" },
        { status: "completed", conclusion: "failure" },
      ])
    ).toBe("failure");
  });

  it("returns failure for timed_out conclusion", () => {
    expect(aggregateCiStatus([{ status: "completed", conclusion: "timed_out" }])).toBe("failure");
  });

  it("returns failure for cancelled conclusion", () => {
    expect(aggregateCiStatus([{ status: "completed", conclusion: "cancelled" }])).toBe("failure");
  });

  it("returns pending when any run is in_progress", () => {
    expect(
      aggregateCiStatus([
        { status: "completed", conclusion: "success" },
        { status: "in_progress", conclusion: null },
      ])
    ).toBe("pending");
  });

  it("returns pending when any run is queued", () => {
    expect(aggregateCiStatus([{ status: "queued", conclusion: null }])).toBe("pending");
  });

  it("returns pending when any run is waiting (environment protection)", () => {
    expect(aggregateCiStatus([{ status: "waiting", conclusion: null }])).toBe("pending");
  });

  it("returns pending when any run is requested", () => {
    expect(aggregateCiStatus([{ status: "requested", conclusion: null }])).toBe("pending");
  });

  it("pending takes precedence over failure", () => {
    expect(
      aggregateCiStatus([
        { status: "in_progress", conclusion: null },
        { status: "completed", conclusion: "failure" },
      ])
    ).toBe("pending");
  });

  it("returns unknown for completed run with unexpected conclusion", () => {
    expect(aggregateCiStatus([{ status: "completed", conclusion: "stale" }])).toBe("unknown");
  });
});

// ─── listPullRequests ─────────────────────────────────────────────────────────

describe("listPullRequests", () => {
  it("returns no-github-remote error when remote is null", async () => {
    const result = await listPullRequests(
      { projectPath: PROJECT_PATH },
      { remoteInfo: null, client: makeOctokitMock() }
    );
    expect(result).toEqual({ error: "no-github-remote" });
  });

  it("returns no-token error when client is null", async () => {
    const result = await listPullRequests(
      { projectPath: PROJECT_PATH },
      { remoteInfo: REMOTE, client: null }
    );
    expect(result).toEqual({ error: "GITHUB_TOKEN not configured" });
  });

  it("returns empty prs array when no PRs exist", async () => {
    const result = await listPullRequests({ projectPath: PROJECT_PATH }, happyDeps());
    expect(result).toEqual({ prs: [] });
  });

  it("maps pull request fields correctly", async () => {
    const rawPr = {
      id: 1,
      number: 42,
      title: "My PR",
      state: "open",
      html_url: "https://github.com/octo-org/example-repo/pull/42",
      draft: false,
      created_at: "2024-01-01T00:00:00Z",
      updated_at: "2024-01-02T00:00:00Z",
      head: { ref: "feature-branch" },
      base: { ref: "main" },
    };

    const client = makeOctokitMock({
      pulls: { list: async () => ({ data: [rawPr] }) } as unknown as OctokitClient["pulls"],
    });
    const result = await listPullRequests({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });

    expect(result).toEqual({
      prs: [
        {
          id: 1,
          number: 42,
          title: "My PR",
          state: "open",
          html_url: "https://github.com/octo-org/example-repo/pull/42",
          draft: false,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
          head_ref: "feature-branch",
          base_ref: "main",
        },
      ],
    });
  });

  it("passes state filter to Octokit", async () => {
    let capturedArgs: unknown;
    const client = makeOctokitMock({
      pulls: {
        list: async (args: unknown) => {
          capturedArgs = args;
          return { data: [] };
        },
      } as unknown as OctokitClient["pulls"],
    });

    await listPullRequests({ projectPath: PROJECT_PATH, state: "closed" }, { remoteInfo: REMOTE, client });
    expect((capturedArgs as { state: string }).state).toBe("closed");
  });

  it("returns typed error on 401", async () => {
    const client = makeOctokitMock({
      pulls: {
        list: async () => { throw makeHttpError(401); },
      } as unknown as OctokitClient["pulls"],
    });
    const result = await listPullRequests({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });
    expect(result).toEqual({ error: "GitHub token is invalid or expired" });
  });

  it("returns typed error on 403", async () => {
    const client = makeOctokitMock({
      pulls: { list: async () => { throw makeHttpError(403); } } as unknown as OctokitClient["pulls"],
    });
    const result = await listPullRequests({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });
    expect((result as { error: string }).error).toMatch(/Forbidden: error/i);
  });

  it("returns typed error on 404", async () => {
    const client = makeOctokitMock({
      pulls: { list: async () => { throw makeHttpError(404); } } as unknown as OctokitClient["pulls"],
    });
    const result = await listPullRequests({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  it("caps per_page at 100 even when limit exceeds it", async () => {
    let capturedPerPage: number | undefined;
    const client = makeOctokitMock({
      pulls: {
        list: async (args: { per_page?: number }) => {
          capturedPerPage = args.per_page;
          return { data: [] };
        },
      } as unknown as OctokitClient["pulls"],
    });
    await listPullRequests({ projectPath: PROJECT_PATH, limit: 200 }, { remoteInfo: REMOTE, client });
    expect(capturedPerPage).toBe(100);
  });
});

// ─── listIssues ───────────────────────────────────────────────────────────────

describe("listIssues", () => {
  it("returns no-github-remote error when remote is null", async () => {
    const result = await listIssues(
      { projectPath: PROJECT_PATH },
      { remoteInfo: null, client: makeOctokitMock() }
    );
    expect(result).toEqual({ error: "no-github-remote" });
  });

  it("returns no-token error when client is null", async () => {
    const result = await listIssues(
      { projectPath: PROJECT_PATH },
      { remoteInfo: REMOTE, client: null }
    );
    expect(result).toEqual({ error: "GITHUB_TOKEN not configured" });
  });

  it("filters out pull requests from the response", async () => {
    const items = [
      { id: 1, number: 1, title: "Real issue", state: "open", html_url: "url1", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z" },
      { id: 2, number: 2, title: "PR disguised as issue", state: "open", html_url: "url2", created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z", pull_request: { url: "https://..." } },
    ];

    const client = makeOctokitMock({
      issues: { listForRepo: async () => ({ data: items }) } as unknown as OctokitClient["issues"],
    });
    const result = await listIssues({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });

    expect(result).toMatchObject({ issues: [{ number: 1, title: "Real issue" }] });
    expect((result as { issues: unknown[] }).issues).toHaveLength(1);
  });

  it("maps issue fields correctly", async () => {
    const rawIssue = {
      id: 10,
      number: 5,
      title: "Bug report",
      state: "open",
      html_url: "https://github.com/octo-org/example-repo/issues/5",
      created_at: "2024-02-01T00:00:00Z",
      updated_at: "2024-02-02T00:00:00Z",
    };
    const client = makeOctokitMock({
      issues: { listForRepo: async () => ({ data: [rawIssue] }) } as unknown as OctokitClient["issues"],
    });
    const result = await listIssues({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });

    expect(result).toEqual({
      issues: [
        {
          id: 10,
          number: 5,
          title: "Bug report",
          state: "open",
          html_url: "https://github.com/octo-org/example-repo/issues/5",
          created_at: "2024-02-01T00:00:00Z",
          updated_at: "2024-02-02T00:00:00Z",
        },
      ],
    });
  });

  it("returns typed error on 401", async () => {
    const client = makeOctokitMock({
      issues: { listForRepo: async () => { throw makeHttpError(401); } } as unknown as OctokitClient["issues"],
    });
    const result = await listIssues({ projectPath: PROJECT_PATH }, { remoteInfo: REMOTE, client });
    expect(result).toEqual({ error: "GitHub token is invalid or expired" });
  });
});

// ─── createPullRequest ────────────────────────────────────────────────────────

describe("createPullRequest", () => {
  it("returns no-github-remote error when remote is null", async () => {
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "My PR", head: "feature", base: "main" },
      { remoteInfo: null, client: makeOctokitMock() }
    );
    expect(result).toEqual({ error: "no-github-remote" });
  });

  it("returns no-token error when client is null", async () => {
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "My PR", head: "feature", base: "main" },
      { remoteInfo: REMOTE, client: null }
    );
    expect(result).toEqual({ error: "GITHUB_TOKEN not configured" });
  });

  it("returns the created PR on success", async () => {
    const createdPr = {
      id: 99,
      number: 7,
      title: "My PR",
      state: "open",
      html_url: "https://github.com/octo-org/example-repo/pull/7",
      draft: false,
      created_at: "2024-03-01T00:00:00Z",
      updated_at: "2024-03-01T00:00:00Z",
      head: { ref: "feature", sha: "abc" },
      base: { ref: "main" },
    };
    const client = makeOctokitMock({
      pulls: { create: async () => ({ data: createdPr }) } as unknown as OctokitClient["pulls"],
    });
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "My PR", head: "feature", base: "main" },
      { remoteInfo: REMOTE, client }
    );

    expect(result).toMatchObject({ pr: { number: 7, html_url: "https://github.com/octo-org/example-repo/pull/7" } });
  });

  it("passes all fields to Octokit create", async () => {
    let capturedArgs: unknown;
    const client = makeOctokitMock({
      pulls: {
        create: async (args: unknown) => {
          capturedArgs = args;
          return {
            data: {
              id: 1, number: 1, title: "T", state: "open", html_url: "u",
              draft: true, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
              head: { ref: "feat", sha: "s" }, base: { ref: "main" },
            },
          };
        },
      } as unknown as OctokitClient["pulls"],
    });

    await createPullRequest(
      { projectPath: PROJECT_PATH, title: "T", body: "B", head: "feat", base: "dev", draft: true },
      { remoteInfo: REMOTE, client }
    );

    expect(capturedArgs).toMatchObject({
      owner: "octo-org",
      repo: "example-repo",
      title: "T",
      body: "B",
      head: "feat",
      base: "dev",
      draft: true,
    });
  });

  it("returns typed error on 422", async () => {
    const client = makeOctokitMock({
      pulls: { create: async () => { throw makeHttpError(422, "head is not a valid ref"); } } as unknown as OctokitClient["pulls"],
    });
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "My PR", head: "feature", base: "main" },
      { remoteInfo: REMOTE, client }
    );
    expect((result as { error: string }).error).toMatch(/validation failed/i);
  });

  it("returns typed error on 401", async () => {
    const client = makeOctokitMock({
      pulls: { create: async () => { throw makeHttpError(401); } } as unknown as OctokitClient["pulls"],
    });
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "T", head: "feature", base: "main" },
      { remoteInfo: REMOTE, client }
    );
    expect(result).toEqual({ error: "GitHub token is invalid or expired" });
  });

  it("fetches repo default branch when base is omitted", async () => {
    let capturedBase: string | undefined;
    const client = makeOctokitMock({
      repos: {
        get: async () => ({ data: { default_branch: "trunk" } }),
      } as unknown as OctokitClient["repos"],
      pulls: {
        create: async (args: { base?: string }) => {
          capturedBase = args.base;
          return {
            data: {
              id: 1, number: 1, title: "T", state: "open", html_url: "u",
              draft: false, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
              head: { ref: "feat", sha: "s" }, base: { ref: "trunk" },
            },
          };
        },
      } as unknown as OctokitClient["pulls"],
    });

    await createPullRequest(
      { projectPath: PROJECT_PATH, title: "T", head: "feat" },
      { remoteInfo: REMOTE, client }
    );
    expect(capturedBase).toBe("trunk");
  });

  it("uses injected currentBranch when head is omitted", async () => {
    let capturedHead: string | undefined;
    const client = makeOctokitMock({
      pulls: {
        create: async (args: { head?: string }) => {
          capturedHead = args.head;
          return {
            data: {
              id: 1, number: 1, title: "T", state: "open", html_url: "u",
              draft: false, created_at: "2024-01-01T00:00:00Z", updated_at: "2024-01-01T00:00:00Z",
              head: { ref: "auto-branch", sha: "s" }, base: { ref: "main" },
            },
          };
        },
      } as unknown as OctokitClient["pulls"],
    });

    await createPullRequest(
      { projectPath: PROJECT_PATH, title: "T", base: "main" },
      { remoteInfo: REMOTE, client, currentBranch: "auto-branch" }
    );
    expect(capturedHead).toBe("auto-branch");
  });

  it("returns error when head is omitted and currentBranch is null", async () => {
    const result = await createPullRequest(
      { projectPath: PROJECT_PATH, title: "T", base: "main" },
      { remoteInfo: REMOTE, client: makeOctokitMock(), currentBranch: null }
    );
    expect((result as { error: string }).error).toMatch(/head branch/i);
  });
});

// ─── getCiStatus ──────────────────────────────────────────────────────────────

describe("getCiStatus", () => {
  it("returns no-github-remote error when remote is null", async () => {
    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "abc123" },
      { remoteInfo: null, client: makeOctokitMock() }
    );
    expect(result).toEqual({ error: "no-github-remote" });
  });

  it("returns no-token error when client is null", async () => {
    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "abc123" },
      { remoteInfo: REMOTE, client: null }
    );
    expect(result).toEqual({ error: "GITHUB_TOKEN not configured" });
  });

  it("returns error when neither ref nor prNumber is provided", async () => {
    const result = await getCiStatus({ projectPath: PROJECT_PATH }, happyDeps());
    expect((result as { error: string }).error).toMatch(/ref or prNumber/i);
  });

  it("returns unknown status when no check runs exist", async () => {
    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "abc123" },
      happyDeps()
    );
    expect(result).toEqual({ status: { state: "unknown" } });
  });

  it("aggregates success when all runs pass", async () => {
    const client = makeOctokitMock({
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "skipped" },
            ],
          },
        }),
      } as unknown as OctokitClient["checks"],
    });

    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "sha-success" },
      { remoteInfo: REMOTE, client }
    );
    expect(result).toEqual({ status: { state: "success" } });
  });

  it("aggregates failure when a run fails", async () => {
    const client = makeOctokitMock({
      checks: {
        listForRef: async () => ({
          data: {
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "failure" },
            ],
          },
        }),
      } as unknown as OctokitClient["checks"],
    });

    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "sha-fail" },
      { remoteInfo: REMOTE, client }
    );
    expect(result).toEqual({ status: { state: "failure" } });
  });

  it("aggregates pending when a run is in_progress", async () => {
    const client = makeOctokitMock({
      checks: {
        listForRef: async () => ({
          data: { check_runs: [{ status: "in_progress", conclusion: null }] },
        }),
      } as unknown as OctokitClient["checks"],
    });

    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "sha-pending" },
      { remoteInfo: REMOTE, client }
    );
    expect(result).toEqual({ status: { state: "pending" } });
  });

  it("resolves SHA from prNumber", async () => {
    let checkRefCalled: string | undefined;
    const client = makeOctokitMock({
      pulls: {
        get: async () => ({
          data: {
            head: { sha: "pr-head-sha", ref: "feature" },
            base: { ref: "main" },
          },
        }),
      } as unknown as OctokitClient["pulls"],
      checks: {
        listForRef: async (args: { ref: string }) => {
          checkRefCalled = args.ref;
          return { data: { check_runs: [] } };
        },
      } as unknown as OctokitClient["checks"],
    });

    await getCiStatus({ projectPath: PROJECT_PATH, prNumber: 42 }, { remoteInfo: REMOTE, client });
    expect(checkRefCalled).toBe("pr-head-sha");
  });

  it("returns typed error when PR lookup fails with 404", async () => {
    const client = makeOctokitMock({
      pulls: {
        get: async () => { throw makeHttpError(404); },
      } as unknown as OctokitClient["pulls"],
    });
    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, prNumber: 999 },
      { remoteInfo: REMOTE, client }
    );
    expect((result as { error: string }).error).toMatch(/not found/i);
  });

  it("returns typed error on 401 when fetching check runs", async () => {
    const client = makeOctokitMock({
      checks: {
        listForRef: async () => { throw makeHttpError(401); },
      } as unknown as OctokitClient["checks"],
    });
    const result = await getCiStatus(
      { projectPath: PROJECT_PATH, ref: "abc123" },
      { remoteInfo: REMOTE, client }
    );
    expect(result).toEqual({ error: "GitHub token is invalid or expired" });
  });
});
