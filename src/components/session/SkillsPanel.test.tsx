import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SkillsPanel } from "@/components/session/SkillsPanel";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, Session, SkillInfo } from "@/types";

// ─── Fixtures ──────────────────────────────────────────────────────────────────

const USER_SKILL: SkillInfo = {
  name: "brainstorming",
  description: "Explores user intent before implementation.",
  path: "/home/user/.claude/skills/brainstorming",
  source: "global",
};

const PLUGIN_SKILL: SkillInfo = {
  name: "optimizing-ef-core",
  description: "EF Core query optimization guidance.",
  path: "/home/user/.claude/plugins/ef-plugin/skills/optimizing-ef-core",
  source: "plugin",
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agent: null,
    skills: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/proj",
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

function setupStores() {
  const session = makeSession();
  const project = makeProject();
  useSessionStore.getState().addSession(session);
  useSessionStore.getState().setActiveSession(session.id);
  useProjectStore.getState().addProject(project);
  useProjectStore.getState().setActiveProject(project.id);
  return { session, project };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SkillsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);
    vi.mocked(window.electronAPI.updateSessionSkills).mockResolvedValue(undefined);
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "---\n---\n\nSkill content." });
  });

  it("renders skill names after loading", async () => {
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(screen.getByText("brainstorming")).toBeInTheDocument();
      expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();
    });
  });

  it("shows the edit (pencil) button only for user skills", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());

    // Hover over the user skill card to reveal action buttons
    await user.hover(screen.getByText("brainstorming").closest("[class*='group']")!);
    const editButtons = screen.getAllByLabelText("Edit skill");
    expect(editButtons).toHaveLength(1); // only user skill card has a pencil
  });

  it("shows the view (eye) button for both user and plugin skills", async () => {
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());

    // Eye buttons are rendered for both skill types (opacity-0 until hover, but present in DOM)
    const viewButtons = screen.getAllByLabelText("View skill");
    expect(viewButtons).toHaveLength(2);
  });

  it("toggles skill active state on card click", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());

    await user.click(screen.getByText("brainstorming"));

    expect(window.electronAPI.updateSessionSkills).toHaveBeenCalledWith(
      "sess-1",
      expect.arrayContaining(["brainstorming"])
    );
  });

  it("shows empty state message when no skills are installed", async () => {
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no skills installed/i)).toBeInTheDocument();
    });
  });

  it("filters skills by source when a filter chip is toggled off", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(screen.getByText("brainstorming")).toBeInTheDocument();
      expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();
    });

    // Toggle off the "plugin" filter — plugin skill should disappear
    await user.click(screen.getByLabelText("Filter plugin skills"));

    expect(screen.getByText("brainstorming")).toBeInTheDocument();
    expect(screen.queryByText("optimizing-ef-core")).not.toBeInTheDocument();

    // Toggle off "global" too — both gone, empty-filter message shows
    await user.click(screen.getByLabelText("Filter global skills"));

    expect(screen.queryByText("brainstorming")).not.toBeInTheDocument();
    expect(screen.getByText(/no skills match the selected filters/i)).toBeInTheDocument();
  });

  it("filters skills by search query (matches name and description)", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(screen.getByText("brainstorming")).toBeInTheDocument();
    });

    const searchInput = screen.getByLabelText("Search skills");

    await user.type(searchInput, "ef-core");
    expect(screen.queryByText("brainstorming")).not.toBeInTheDocument();
    expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();

    // Clear via the X button restores everything
    await user.click(screen.getByLabelText("Clear search"));
    expect(screen.getByText("brainstorming")).toBeInTheDocument();
    expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();

    // Match by description text
    await user.type(searchInput, "user intent");
    expect(screen.getByText("brainstorming")).toBeInTheDocument();
    expect(screen.queryByText("optimizing-ef-core")).not.toBeInTheDocument();

    // No matches → empty state mentions the query
    await user.clear(searchInput);
    await user.type(searchInput, "nonexistent");
    expect(screen.getByText(/no skills match "nonexistent"/i)).toBeInTheDocument();
  });
});
