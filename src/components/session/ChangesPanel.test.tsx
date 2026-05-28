import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { FileChange, Project, Session } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "/project/src/foo.ts",
    relativePath: "src/foo.ts",
    diff: [
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "-old line",
      "+new line",
      "+added line",
    ].join("\n"),
    operation: "write",
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "proj-1",
    title: id,
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    branch: null,
    workspace_path: null,
    agent: null,
    skills: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
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

describe("diff content rendering", () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {} });
  });

  it("renders added lines in the diff", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain("+new line");
  });

  it("renders removed lines in the diff", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain("-old line");
  });

  it("renders hunk headers in the diff", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain("@@");
  });

  it("renders context lines in the diff", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    fireEvent.click(container.querySelector("button")!);
    expect(container.textContent).toContain(" unchanged");
  });
});

// ─── Empty states ─────────────────────────────────────────────────────────────

describe("ChangesPanel empty states", () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {} });
  });

  it("shows 'No active session' when there is no active session", () => {
    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText(/no active session/i)).toBeInTheDocument();
  });

  it("shows 'No file changes yet' when session exists but no changes", () => {
    useSessionStore.getState().addSession(makeSession("sess-empty"));
    useSessionStore.getState().setActiveSession("sess-empty");

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText(/no file changes yet/i)).toBeInTheDocument();
  });

  it("shows file path once a change is added", () => {
    useSessionStore.getState().addSession(makeSession("sess-with"));
    useSessionStore.getState().setActiveSession("sess-with");
    useSessionStore.getState().addFileChange("sess-with", makeFileChange());

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("shows 'delete' badge for delete operations", () => {
    useSessionStore.getState().addSession(makeSession("sess-del"));
    useSessionStore.getState().setActiveSession("sess-del");
    useSessionStore.getState().addFileChange("sess-del", makeFileChange({ operation: "delete" }));

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("delete")).toBeInTheDocument();
  });

  it("shows 'write' badge for write operations", () => {
    useSessionStore.getState().addSession(makeSession("sess-wr"));
    useSessionStore.getState().setActiveSession("sess-wr");
    useSessionStore.getState().addFileChange("sess-wr", makeFileChange({ operation: "write" }));

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("write")).toBeInTheDocument();
  });

  it("shows 'No project path available' when active project has no path", () => {
    renderWithProviders(<ChangesPanel />);
    // No active project is set in projectStore → git diff section fallback
    expect(
      screen.getByText(/no project path available for git diff/i)
    ).toBeInTheDocument();
  });
});

describe("ChangesPanel Open PR flow", () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {} });
    useProjectStore.setState({ projects: [], activeProjectId: null });
    window.electronAPI.getGitBranch = vi.fn().mockResolvedValue("feature/open-pr");
    window.electronAPI.githubGetPrContext = vi
      .fn()
      .mockResolvedValue({ hasRemote: true, defaultBase: "main" });
    window.electronAPI.githubCreatePr = vi.fn().mockResolvedValue({
      pr: {
        id: 10,
        number: 12,
        title: "Session title",
        state: "open",
        html_url: "https://github.com/acme/repo/pull/12",
      },
    });
    window.electronAPI.openGitHubUrl = vi.fn().mockResolvedValue(undefined);
  });

  it("hides Open PR when GitHub token is missing", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue(null);
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /open pr form/i })).not.toBeInTheDocument();
    });
    expect(window.electronAPI.githubGetPrContext).not.toHaveBeenCalled();
    expect(window.electronAPI.getGitBranch).not.toHaveBeenCalled();
  });

  it("hides Open PR when project has no GitHub remote", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    window.electronAPI.githubGetPrContext = vi
      .fn()
      .mockResolvedValue({ hasRemote: false, defaultBase: null });
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: /open pr form/i })).not.toBeInTheDocument();
    });
  });

  it("prefills title/base/head when opening the PR form", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);

    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));

    expect(window.electronAPI.getGitBranch).toHaveBeenCalledWith("/worktrees/sess-pr");
    expect(screen.getByPlaceholderText("PR title")).toHaveValue("Session title");
    expect(screen.getByPlaceholderText("Auto-detect if empty")).toHaveValue("main");
    expect(screen.getByPlaceholderText("feature-branch")).toHaveValue("feature/open-pr");
    expect(screen.getByPlaceholderText("Optional PR description")).toHaveValue("");
  });

  it("submits create PR payload and opens created URL", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    await waitFor(() => {
      expect(window.electronAPI.githubCreatePr).toHaveBeenCalledWith({
        projectPath: "/worktrees/sess-pr",
        title: "Session title",
        body: undefined,
        head: "feature/open-pr",
        base: "main",
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    expect(window.electronAPI.openGitHubUrl).toHaveBeenCalledWith(
      "https://github.com/acme/repo/pull/12"
    );
  });

  it("renders inline error when create PR fails", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    window.electronAPI.githubCreatePr = vi.fn().mockResolvedValue({ error: "Validation failed" });
    useSessionStore.getState().addSession(makeSession("sess-pr", { title: "Session title" }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(screen.getByRole("button", { name: "Create PR" }));

    expect(await screen.findByText("Validation failed")).toBeInTheDocument();
  });
});
