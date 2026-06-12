import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { ProjectSidebar } from "@/components/layout/ProjectSidebar";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, Session } from "@/types";

vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelectorLogo: () => null,
}));

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "my-project",
    path: "/home/user/my-project",
    config: {
      provider: "anthropic",
      model: "",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    created_at: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "My session",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    branch: null,
    workspace_path: null,
    agent: null,
    skills: null,
    github_issue_number: null,
    ...overrides,
  };
}

function renderSidebar(collapsed = false) {
  const onCollapsedChange = vi.fn();
  renderWithProviders(
    <ProjectSidebar collapsed={collapsed} onCollapsedChange={onCollapsedChange} />
  );
  return { onCollapsedChange };
}

describe("ProjectSidebar — initial load", () => {
  it("renders project names after listProjects resolves", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "alpha" }),
      makeProject({ id: "proj-2", name: "beta" }),
    ]);

    renderSidebar();

    await screen.findByText("alpha");
    await screen.findByText("beta");
  });

  it("renders session titles nested under their project", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "alpha" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "First session" }),
      makeSession({ id: "sess-2", title: "Second session" }),
    ]);

    renderSidebar();

    await screen.findByText("First session");
    await screen.findByText("Second session");
  });

  it("selects the first session of the active project on load", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-a", created_at: "2024-01-01T00:00:00Z" }),
      makeSession({ id: "sess-b", created_at: "2024-01-02T00:00:00Z" }),
    ]);

    renderSidebar();

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe("sess-a");
    });
  });

  it("shows 'No sessions' when a project has no sessions", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "empty-project" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);

    renderSidebar();

    await screen.findByText("empty-project");
    expect(screen.getByText("No sessions")).toBeInTheDocument();
  });

  it("logs an error but still renders when listSessions fails for a project", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "alpha" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockRejectedValue(new Error("IPC error"));

    renderSidebar();

    await screen.findByText("alpha");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("listSessions failed for project proj-1"),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

describe("ProjectSidebar — project interaction", () => {
  it("sets the clicked project as active", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "alpha" }),
      makeProject({ id: "proj-2", name: "beta" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    useProjectStore.setState({ activeProjectId: "proj-1" });

    renderSidebar();

    await screen.findByText("beta");
    await userEvent.click(screen.getByLabelText("beta"));

    expect(useProjectStore.getState().activeProjectId).toBe("proj-2");
  });

  it("creates a new session and makes it active when the + button is clicked", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1", name: "alpha" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderSidebar();

    await screen.findByText("alpha");
    await userEvent.click(screen.getByLabelText("New session"));

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", undefined, undefined);
    await screen.findByText("New session");
    expect(useSessionStore.getState().activeSessionId).toBe("sess-new");
  });
});

describe("ProjectSidebar — provider dropdown", () => {
  it("passes 'anthropic' to createSession when New Claude session is picked", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1", name: "alpha" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderSidebar();
    await screen.findByText("alpha");

    await userEvent.click(screen.getByLabelText("New session with specific provider"));
    await userEvent.click(await screen.findByText("New Claude session"));

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", "anthropic", undefined);
  });

  it("passes 'copilot' to createSession when New Copilot session is picked", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1", name: "alpha" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderSidebar();
    await screen.findByText("alpha");

    await userEvent.click(screen.getByLabelText("New session with specific provider"));
    await userEvent.click(await screen.findByText("New Copilot session"));

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", "copilot", undefined);
  });

  it("disables a provider menu item when its probe reports unavailable", async () => {
    vi.mocked(window.electronAPI.probeProviders).mockResolvedValue({
      anthropic: { ok: true },
      copilot: { ok: false, reason: "GITHUB_TOKEN not set" },
      ollama: { ok: true },
      "openai-compatible": { ok: true },
    });
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1", name: "alpha" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);

    renderSidebar();
    await screen.findByText("alpha");

    await userEvent.click(screen.getByLabelText("New session with specific provider"));
    await screen.findByText("New Copilot session");
    // Re-query inside waitFor to avoid a stale reference if Base UI mutates the DOM
    // node when applying data-disabled after the async probe resolves.
    await waitFor(() => {
      expect(screen.getByText("New Copilot session").closest("[data-disabled]")).toBeTruthy();
    });
  });
});

describe("ProjectSidebar — session badges", () => {
  it("shows a #N issue badge for sessions with github_issue_number set", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "Issue session", github_issue_number: 42 }),
    ]);

    renderSidebar();
    await screen.findByText("Issue session");
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("does not show an issue badge when github_issue_number is null", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "Plain session", github_issue_number: null }),
    ]);

    renderSidebar();
    await screen.findByText("Plain session");
    expect(screen.queryByText("42")).not.toBeInTheDocument();
  });

  it("shows an agent badge when a session has a selected agent", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([makeProject({ id: "proj-1" })]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "Agent session" }),
    ]);
    useSessionStore.setState({ sessionAgents: { "sess-1": "my-agent" } });

    renderSidebar();
    await screen.findByText("Agent session");
    expect(screen.getByText("my-agent")).toBeInTheDocument();
  });
});

describe("ProjectSidebar — session interaction", () => {
  it("switches active session when a session row is clicked", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "First" }),
      makeSession({ id: "sess-2", title: "Second" }),
    ]);

    renderSidebar();

    await screen.findByText("Second");
    await userEvent.click(screen.getByText("Second"));

    expect(useSessionStore.getState().activeSessionId).toBe("sess-2");
  });

  it("auto-selects the next session when the active session is deleted", async () => {
    vi.mocked(window.electronAPI.listProjects).mockResolvedValue([
      makeProject({ id: "proj-1" }),
    ]);
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "First", branch: "b1", workspace_path: "/tmp" }),
      makeSession({ id: "sess-2", title: "Second", created_at: "2024-01-02T00:00:00Z" }),
    ]);
    vi.mocked(window.electronAPI.deleteSession).mockResolvedValue(undefined);
    useSessionStore.setState({ activeSessionId: "sess-1" });

    renderSidebar();

    await screen.findByText("First");

    // Two sessions → two delete buttons; click the first one (for "First")
    const [firstDeleteBtn] = screen.getAllByLabelText("Delete session");
    await userEvent.click(firstDeleteBtn);
    // Confirm in the dialog — click the last "Delete session" button
    const allDeleteBtns = await screen.findAllByRole("button", { name: /delete session/i });
    await userEvent.click(allDeleteBtns[allDeleteBtns.length - 1]);

    await waitFor(() => {
      expect(useSessionStore.getState().activeSessionId).toBe("sess-2");
    });
  });
});
