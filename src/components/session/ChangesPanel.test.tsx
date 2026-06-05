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
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {}, sessionAgents: {} });
    useProjectStore.setState({ projects: [], activeProjectId: null });
    window.localStorage.removeItem("aichemist.prDescriptionHistoryLimit");
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
    window.electronAPI.getGitDiff = vi.fn().mockResolvedValue("diff --git a/file.ts b/file.ts\n+new line");
    window.electronAPI.agentSend = vi.fn().mockResolvedValue({ queued: false });
    window.electronAPI.readFile = vi.fn().mockResolvedValue({ error: "not found" });
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

  it("streams generated output and applies parsed title/body after completion", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
      messages: [
        {
          id: "m1",
          session_id: "sess-pr",
          role: "user",
          content: "Please summarize this work.",
          tool_calls: [],
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });
    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1] as
      | ((payload: { session_id: string; text_delta: string }) => void)
      | undefined;

    const titleInput = screen.getByPlaceholderText("PR title");
    const textarea = screen.getByPlaceholderText("Optional PR description");

    deltaListener?.({ session_id: "sess-pr", text_delta: "Title: Generated heading" });
    await waitFor(() => {
      expect(textarea).toHaveValue("Title: Generated heading");
    });
    deltaListener?.({ session_id: "sess-pr", text_delta: "\n\nBody:\n- bullet" });
    await waitFor(() => {
      expect(textarea).toHaveValue("Title: Generated heading\n\nBody:\n- bullet");
    });

    resolveSend?.();
    await waitFor(() => {
      expect(window.electronAPI.agentSend).toHaveBeenCalledOnce();
      expect(titleInput).toHaveValue("Generated heading");
      expect(textarea).toHaveValue("- bullet");
    });
  });

  it("clears description when parsed generated body is empty", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });
    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1] as
      | ((payload: { session_id: string; text_delta: string }) => void)
      | undefined;

    const titleInput = screen.getByPlaceholderText("PR title");
    const textarea = screen.getByPlaceholderText("Optional PR description");
    deltaListener?.({ session_id: "sess-pr", text_delta: "Title: Generated heading\n\nBody:\n" });
    await waitFor(() => {
      expect(textarea).toHaveValue("Title: Generated heading\n\nBody:\n");
    });

    resolveSend?.();
    await waitFor(() => {
      expect(titleInput).toHaveValue("Generated heading");
      expect(textarea).toHaveValue("");
    });
  });

  it("immediately shows Cancel and locks UI during prompt assembly (before getGitDiff returns)", async () => {
    window.electronAPI.getGitDiff = vi.fn().mockImplementation(
      () => new Promise<string>(() => { /* never resolves */ })
    );
    window.electronAPI.agentSend = vi.fn().mockResolvedValue({ queued: false });
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    // Button switches to Cancel immediately — before getGitDiff resolves
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Optional PR description")).toHaveProperty("readOnly", true);
    expect(screen.getByRole("button", { name: "Create PR" })).toBeDisabled();
  });

  it("cancelling during prompt assembly aborts generation before agentSend fires", async () => {
    window.electronAPI.getGitDiff = vi.fn().mockImplementation(
      () => new Promise<string>(() => { /* never resolves */ })
    );
    window.electronAPI.agentSend = vi.fn().mockResolvedValue({ queued: false });
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
    const textarea = await screen.findByPlaceholderText("Optional PR description");
    fireEvent.change(textarea, { target: { value: "Original text" } });
    fireEvent.click(screen.getByRole("button", { name: /generate/i }));

    fireEvent.click(await screen.findByRole("button", { name: /cancel/i }));

    await waitFor(() => {
      expect(window.electronAPI.agentSend).not.toHaveBeenCalled();
      expect(textarea).toHaveValue("Original text");
      expect(screen.getByRole("button", { name: /generate/i })).toBeInTheDocument();
    });
  });

  it("clamps local storage history limit when building the generation prompt", async () => {
    window.localStorage.setItem("aichemist.prDescriptionHistoryLimit", "1000");
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
      messages: [
        {
          id: "m1",
          session_id: "sess-pr",
          role: "user",
          content: "Please summarize this work.",
          tool_calls: [],
          created_at: "2024-01-01T00:00:00Z",
        },
      ],
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.agentSend).toHaveBeenCalledOnce();
      expect(window.electronAPI.agentSend).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining("Recent conversation messages (last 50):"),
      }));
    });
  });

  it("uses configured history limit when local storage value is valid and under max", async () => {
    window.localStorage.setItem("aichemist.prDescriptionHistoryLimit", "7");
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.agentSend).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining("Recent conversation messages (last 7):"),
      }));
    });
  });

  it("falls back to the default history limit when local storage value is invalid", async () => {
    window.localStorage.setItem("aichemist.prDescriptionHistoryLimit", "invalid");
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.agentSend).toHaveBeenCalledWith(expect.objectContaining({
        prompt: expect.stringContaining("Recent conversation messages (last 10):"),
      }));
    });
  });

  it("uses the selected session agent for PR draft generation", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
    }));
    useSessionStore.getState().setSessionAgent("sess-pr", "planner");
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.agentSend).toHaveBeenCalledWith(expect.objectContaining({
        agent: "planner",
      }));
    });
  });

  it("prevents submitting and locks description edits while generation is in progress", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    const textarea = await screen.findByPlaceholderText("Optional PR description");
    const createPrButton = screen.getByRole("button", { name: "Create PR" });
    expect(textarea).toHaveProperty("readOnly", true);
    expect(createPrButton).toBeDisabled();
    fireEvent.click(createPrButton);
    expect(window.electronAPI.githubCreatePr).not.toHaveBeenCalled();

    resolveSend?.();
    await waitFor(() => {
      expect(createPrButton).toBeEnabled();
      expect(textarea).toHaveProperty("readOnly", false);
    });
  });

  it("cleans up generation stream subscription when the component unmounts", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    const { unmount } = renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });

    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1];

    unmount();

    expect(window.electronAPI.off).toHaveBeenCalledWith("session:delta", deltaListener);
    resolveSend?.();
  });

  it("restores the original description when generation is cancelled", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
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
    const textarea = await screen.findByPlaceholderText("Optional PR description");
    fireEvent.change(textarea, { target: { value: "Original description" } });
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });
    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1] as
      | ((payload: { session_id: string; text_delta: string }) => void)
      | undefined;
    deltaListener?.({ session_id: "sess-pr", text_delta: "Draft text" });
    await waitFor(() => {
      expect(textarea).toHaveValue("Draft text");
    });

    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(textarea).toHaveValue("Original description");

    deltaListener?.({ session_id: "sess-pr", text_delta: "ignored" });
    expect(textarea).toHaveValue("Original description");

    resolveSend?.();
  });

  it("shows generate error and keeps description unchanged on failure", async () => {
    window.electronAPI.agentSend = vi.fn().mockRejectedValue(new Error("Generation failed"));
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
    const textarea = await screen.findByPlaceholderText("Optional PR description");
    fireEvent.change(textarea, { target: { value: "Keep this text" } });

    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    expect(await screen.findByText("Generation failed")).toBeInTheDocument();
    expect(textarea).toHaveValue("Keep this text");
  });

  it("parses title/body correctly when model emits preamble before Title:", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });
    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1] as ((payload: { session_id: string; text_delta: string }) => void) | undefined;

    deltaListener?.({
      session_id: "sess-pr",
      text_delta: "Sure! Here is your PR draft.\n\nTitle: Fix the bug\n\nBody:\n- solved it",
    });

    resolveSend?.();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("PR title")).toHaveValue("Fix the bug");
      expect(screen.getByPlaceholderText("Optional PR description")).toHaveValue("- solved it");
    });
  });

  it("parses title/body correctly when model uses markdown heading markers", async () => {
    let resolveSend: (() => void) | undefined;
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          resolveSend = () => resolve({ queued: false });
        })
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });
    const deltaListener = vi
      .mocked(window.electronAPI.on)
      .mock.calls
      .filter(([channel]) => channel === "session:delta")
      .at(-1)?.[1] as ((payload: { session_id: string; text_delta: string }) => void) | undefined;

    // Model emits markdown heading-style markers: "## Title:" and "## Body:"
    deltaListener?.({
      session_id: "sess-pr",
      text_delta: "## Title: Add markdown heading support\n\n## Body:\n- updated parser",
    });

    resolveSend?.();
    await waitFor(() => {
      expect(screen.getByPlaceholderText("PR title")).toHaveValue("Add markdown heading support");
      expect(screen.getByPlaceholderText("Optional PR description")).toHaveValue("- updated parser");
    });
  });

  it("disables Generate button and shows error when session is running", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    useSessionStore.getState().addSession(makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
      status: "running",
    }));
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));

    const generateButton = await screen.findByRole("button", { name: /generate/i });
    expect(generateButton).toBeDisabled();
  });

  it("rejects generateDescription call when session becomes busy between render and click", async () => {
    window.electronAPI.getApiKey = vi.fn().mockResolvedValue("ghp_test");
    const session = makeSession("sess-pr", {
      title: "Session title",
      workspace_path: "/worktrees/sess-pr",
      branch: "aichemist/sess-pr",
    });
    useSessionStore.getState().addSession(session);
    useSessionStore.getState().setActiveSession("sess-pr");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<ChangesPanel />);
    fireEvent.click(await screen.findByRole("button", { name: /open pr form/i }));

    useSessionStore.getState().updateSessionStatus("sess-pr", "running");

    const generateButton = await screen.findByRole("button", { name: /generate/i });
    fireEvent.click(generateButton);

    expect(window.electronAPI.agentSend).not.toHaveBeenCalled();
  });

  it("shows error when Generate is clicked while a prior generation is still in flight", async () => {
    window.electronAPI.agentSend = vi.fn().mockImplementation(
      () => new Promise<{ queued: boolean }>(() => { /* never resolves */ })
    );
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    await waitFor(() => {
      expect(window.electronAPI.on).toHaveBeenCalledWith("session:delta", expect.any(Function));
    });

    // Cancel restores description + isGenerating=false, but agentSend is still running
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    // Re-clicking Generate while agentSend is in flight should show an error
    await waitFor(async () => {
      fireEvent.click(screen.getByRole("button", { name: /generate/i }));
      expect(await screen.findByText(/generation is still in progress/i)).toBeInTheDocument();
    });

    expect(window.electronAPI.agentSend).toHaveBeenCalledOnce();
  });

  it("shows error when getGitDiff throws during prompt assembly", async () => {
    window.electronAPI.getGitDiff = vi.fn().mockRejectedValue(new Error("IPC channel error"));
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
    fireEvent.click(await screen.findByRole("button", { name: /generate/i }));

    expect(await screen.findByText("IPC channel error")).toBeInTheDocument();
    expect(window.electronAPI.agentSend).not.toHaveBeenCalled();
  });
});
