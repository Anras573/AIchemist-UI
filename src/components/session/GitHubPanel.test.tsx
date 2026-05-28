import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { GitHubPanel } from "./GitHubPanel";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { GitHubIssue, GitHubPR, Project } from "@/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Repo",
    path: "/project",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    ...overrides,
  };
}

function makePr(overrides: Partial<GitHubPR> = {}): GitHubPR {
  return {
    id: 1,
    number: 1,
    title: "Example PR",
    state: "open",
    html_url: "https://github.com/acme/repo/pull/1",
    head_sha: "sha-1",
    ...overrides,
  };
}

function makeIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 1,
    number: 1,
    title: "Example issue",
    state: "open",
    html_url: "https://github.com/acme/repo/issues/1",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("GitHubPanel", () => {
  it("shows provider-gated placeholder for ACP sessions", () => {
    useProjectStore.getState().addProject(makeProject({
      id: "proj-acp",
      config: {
        provider: "acp",
        model: "acp",
        approval_mode: "custom",
        approval_rules: [],
        custom_tools: [],
        allowed_tools: [],
        create_worktree_per_session: false,
      },
    }));
    useProjectStore.getState().setActiveProject("proj-acp");

    renderWithProviders(<GitHubPanel />);

    expect(screen.getByText(/not available for acp sessions/i)).toBeInTheDocument();
    expect(window.electronAPI.githubListPrs).not.toHaveBeenCalled();
    expect(window.electronAPI.githubListIssues).not.toHaveBeenCalled();
  });

  it("renders empty states and refreshes data", async () => {
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");
    window.electronAPI.githubListPrs = vi.fn().mockResolvedValue({ prs: [] });
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("No open pull requests")).toBeInTheDocument();
    expect(screen.getByText("No open issues")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => {
      expect(window.electronAPI.githubListPrs).toHaveBeenCalledTimes(2);
      expect(window.electronAPI.githubListIssues).toHaveBeenCalledTimes(2);
    });
  });

  it("renders CI badges from PR head SHAs", async () => {
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");
    window.electronAPI.githubListPrs = vi.fn().mockResolvedValue({
      prs: [makePr({ title: "Passing PR", head_sha: "sha-passing" })],
    });
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });
    window.electronAPI.githubGetCiStatus = vi.fn().mockResolvedValue({
      status: { state: "success" },
    });

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("Passing PR")).toBeInTheDocument();
    expect(await screen.findByText("passing")).toBeInTheDocument();
    await waitFor(() => {
      expect(window.electronAPI.githubGetCiStatus).toHaveBeenCalledWith({
        projectPath: "/project",
        ref: "sha-passing",
      });
    });
  });

  it("refreshes CI for a single PR without navigating", async () => {
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");
    window.electronAPI.githubListPrs = vi.fn().mockResolvedValue({
      prs: [
        makePr({ id: 1, number: 1, title: "PR One", head_sha: "sha-1" }),
        makePr({ id: 2, number: 2, title: "PR Two", head_sha: "sha-2" }),
      ],
    });
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });
    const ciCalls: string[] = [];
    window.electronAPI.githubGetCiStatus = vi.fn().mockImplementation(
      async (args: { ref?: string; prNumber?: number }) => {
        const key = args.ref ?? `pr:${args.prNumber}`;
        ciCalls.push(key);
        return {
          status: {
            state: key === "sha-1" ? "success" : "pending",
          },
        };
      }
    );

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("PR One")).toBeInTheDocument();
    expect(await screen.findByText("passing")).toBeInTheDocument();
    expect(await screen.findByText("pending")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh CI status for PR #1" }));

    await waitFor(() => {
      expect(window.electronAPI.githubGetCiStatus).toHaveBeenCalledTimes(3);
    });
    expect(ciCalls).toEqual(["sha-1", "sha-2", "sha-1"]);
    expect(window.electronAPI.openGitHubUrl).not.toHaveBeenCalled();
  });

  it("keeps the panel visible when CI lookup fails", async () => {
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");
    window.electronAPI.githubListPrs = vi.fn().mockResolvedValue({
      prs: [makePr({ title: "PR with no CI", head_sha: "sha-none" })],
    });
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });
    window.electronAPI.githubGetCiStatus = vi.fn().mockResolvedValue({
      error: "Repository not found or private without 'repo' scope",
    });

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("PR with no CI")).toBeInTheDocument();
    expect(await screen.findByText("unknown")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("ignores stale responses when a newer request finishes first", async () => {
    const projectOne = makeProject({ id: "proj-1", path: "/project-one" });
    const projectTwo = makeProject({ id: "proj-2", path: "/project-two" });
    useProjectStore.getState().addProject(projectOne);
    useProjectStore.getState().addProject(projectTwo);
    useProjectStore.getState().setActiveProject("proj-1");

    const prsFirst = deferred<{ prs: GitHubPR[] }>();
    const prsSecond = deferred<{ prs: GitHubPR[] }>();
    const issuesFirst = deferred<{ issues: GitHubIssue[] }>();
    const issuesSecond = deferred<{ issues: GitHubIssue[] }>();

    let prsCalls = 0;
    let issueCalls = 0;
    window.electronAPI.githubListPrs = vi.fn().mockImplementation(() => {
      prsCalls += 1;
      return prsCalls === 1 ? prsFirst.promise : prsSecond.promise;
    });
    window.electronAPI.githubListIssues = vi.fn().mockImplementation(() => {
      issueCalls += 1;
      return issueCalls === 1 ? issuesFirst.promise : issuesSecond.promise;
    });

    renderWithProviders(<GitHubPanel />);

    useProjectStore.getState().setActiveProject("proj-2");

    prsSecond.resolve({ prs: [makePr({ id: 2, number: 2, title: "Fresh PR" })] });
    issuesSecond.resolve({ issues: [makeIssue({ id: 2, number: 2, title: "Fresh issue" })] });

    expect(await screen.findByText("Fresh PR")).toBeInTheDocument();
    expect(screen.getByText("Fresh issue")).toBeInTheDocument();

    prsFirst.resolve({ prs: [makePr({ id: 3, number: 3, title: "Stale PR" })] });
    issuesFirst.resolve({ issues: [makeIssue({ id: 3, number: 3, title: "Stale issue" })] });

    await waitFor(() => {
      expect(screen.queryByText("Stale PR")).not.toBeInTheDocument();
      expect(screen.queryByText("Stale issue")).not.toBeInTheDocument();
    });
  });

  it("ignores stale CI responses after switching projects", async () => {
    const projectOne = makeProject({ id: "proj-1", path: "/project-one" });
    const projectTwo = makeProject({ id: "proj-2", path: "/project-two" });
    useProjectStore.getState().addProject(projectOne);
    useProjectStore.getState().addProject(projectTwo);
    useProjectStore.getState().setActiveProject("proj-1");

    const firstCi = deferred<{ status: { state: "failure" } }>();
    const secondCi = deferred<{ status: { state: "success" } }>();

    window.electronAPI.githubListPrs = vi.fn().mockImplementation(
      async (args: { projectPath: string }) => ({
        prs:
          args.projectPath === "/project-one"
            ? [makePr({ id: 1, number: 1, title: "First PR", head_sha: "sha-1" })]
            : [makePr({ id: 2, number: 2, title: "Second PR", head_sha: "sha-2" })],
      })
    );
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });
    window.electronAPI.githubGetCiStatus = vi.fn().mockImplementation(
      async (args: { ref?: string }) =>
        args.ref === "sha-1" ? firstCi.promise : secondCi.promise
    );

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("First PR")).toBeInTheDocument();

    useProjectStore.getState().setActiveProject("proj-2");
    secondCi.resolve({ status: { state: "success" } });

    expect(await screen.findByText("Second PR")).toBeInTheDocument();
    expect(await screen.findByText("passing")).toBeInTheDocument();

    firstCi.resolve({ status: { state: "failure" } });

    await waitFor(() => {
      expect(screen.queryByText("First PR")).not.toBeInTheDocument();
      expect(screen.queryByText("failing")).not.toBeInTheDocument();
    });
  });

  it("does not refetch stale PR CI against the new project path during project switch", async () => {
    const projectOne = makeProject({ id: "proj-1", path: "/project-one" });
    const projectTwo = makeProject({ id: "proj-2", path: "/project-two" });
    useProjectStore.getState().addProject(projectOne);
    useProjectStore.getState().addProject(projectTwo);
    useProjectStore.getState().setActiveProject("proj-1");

    const secondPrs = deferred<{ prs: GitHubPR[] }>();
    const ciCalls: Array<{ projectPath: string; ref?: string; prNumber?: number }> = [];

    window.electronAPI.githubListPrs = vi.fn().mockImplementation(
      async (args: { projectPath: string }) =>
        args.projectPath === "/project-one"
          ? { prs: [makePr({ id: 1, number: 1, title: "First PR", head_sha: "sha-1" })] }
          : secondPrs.promise
    );
    window.electronAPI.githubListIssues = vi.fn().mockResolvedValue({ issues: [] });
    window.electronAPI.githubGetCiStatus = vi.fn().mockImplementation(
      async (args: { projectPath: string; ref?: string; prNumber?: number }) => {
        ciCalls.push(args);
        return { status: { state: "success" } };
      }
    );

    renderWithProviders(<GitHubPanel />);

    expect(await screen.findByText("First PR")).toBeInTheDocument();
    await waitFor(() => {
      expect(ciCalls).toContainEqual({ projectPath: "/project-one", ref: "sha-1" });
    });

    useProjectStore.getState().setActiveProject("proj-2");

    await waitFor(() => {
      expect(ciCalls).not.toContainEqual({ projectPath: "/project-two", ref: "sha-1" });
    });

    secondPrs.resolve({
      prs: [makePr({ id: 2, number: 2, title: "Second PR", head_sha: "sha-2" })],
    });

    expect(await screen.findByText("Second PR")).toBeInTheDocument();
  });
});
