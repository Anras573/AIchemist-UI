import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SkillsPanel } from "@/components/session/SkillsPanel";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { SkillInfo } from "@/types";
import { makeProject, makeSession } from "@/test/utils/fixtures";

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
  plugin: "anras573/ef-toolkit",
};

function setupStores() {
  const session = makeSession();
  const project = makeProject({ path: "/home/user/proj" });
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

  it("deep-links New Skill into the hub Skills section instead of editing inline", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<SkillsPanel />);

    await user.click(await screen.findByRole("button", { name: /new skill/i }));

    // No inline create modal — the panel navigates to the hub instead.
    expect(screen.queryByRole("heading", { name: "New Skill" })).not.toBeInTheDocument();
    const { settingsOpen, settingsSection } = useProjectStore.getState();
    expect(settingsOpen).toBe(true);
    expect(settingsSection).toEqual({ scope: "app", id: "skills" });
  });

  it("deep-links the edit (pencil) into the hub Skills section", async () => {
    const user = userEvent.setup();
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());
    await user.click(screen.getByLabelText("Edit skill"));

    const { settingsOpen, settingsSection } = useProjectStore.getState();
    expect(settingsOpen).toBe(true);
    expect(settingsSection).toEqual({ scope: "app", id: "skills" });
  });

  it("shows empty state message when no skills are installed", async () => {
    setupStores();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no skills installed/i)).toBeInTheDocument();
    });
  });

  it("loads skills for Ollama sessions", async () => {
    setupStores();
    useSessionStore.getState().addSession(makeSession({
      id: "sess-ollama",
      provider: "ollama",
      model: "llama3.2",
    }));
    useSessionStore.getState().setActiveSession("sess-ollama");
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL]);

    renderWithProviders(<SkillsPanel />);

    await waitFor(() => {
      expect(window.electronAPI.listSkills).toHaveBeenCalledWith("/home/user/proj", "ollama");
      expect(screen.getByText("brainstorming")).toBeInTheDocument();
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

    // Match by plugin name
    await user.clear(searchInput);
    await user.type(searchInput, "ef-toolkit");
    expect(screen.queryByText("brainstorming")).not.toBeInTheDocument();
    expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();

    // No matches → empty state mentions the query
    await user.clear(searchInput);
    await user.type(searchInput, "nonexistent");
    expect(screen.getByText(/no skills match "nonexistent"/i)).toBeInTheDocument();
  });
});
