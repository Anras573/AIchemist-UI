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
});
