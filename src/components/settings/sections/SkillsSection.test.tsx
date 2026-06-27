import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SkillsSection } from "@/components/settings/sections/SkillsSection";
import type { SkillInfo } from "@/types";

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

describe("SkillsSection (hub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "---\n---\n\nSkill content." });
  });

  it("lists skills using the resolved provider and project path", async () => {
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsSection provider="copilot" projectPath="/proj" />);

    await waitFor(() => {
      expect(screen.getByText("brainstorming")).toBeInTheDocument();
      expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();
    });
    expect(window.electronAPI.listSkills).toHaveBeenCalledWith("/proj", "copilot");
  });

  it("falls back to listing global/plugin skills with no project path", async () => {
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL]);

    renderWithProviders(<SkillsSection provider="anthropic" projectPath="" />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());
    expect(window.electronAPI.listSkills).toHaveBeenCalledWith("", "anthropic");
  });

  it("shows the edit (pencil) button only for non-plugin skills", async () => {
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsSection provider="anthropic" projectPath="/proj" />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());
    // Eye for both; pencil only for the user skill.
    expect(screen.getAllByLabelText("View skill")).toHaveLength(2);
    expect(screen.getAllByLabelText("Edit skill")).toHaveLength(1);
  });

  it("opens the create modal from the New Skill button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SkillsSection provider="anthropic" projectPath="/proj" />);

    await user.click(await screen.findByRole("button", { name: "New Skill" }));

    expect(await screen.findByRole("heading", { name: "New Skill" })).toBeInTheDocument();
  });

  it("filters skills by the search query", async () => {
    const user = userEvent.setup();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([USER_SKILL, PLUGIN_SKILL]);

    renderWithProviders(<SkillsSection provider="anthropic" projectPath="/proj" />);

    await waitFor(() => expect(screen.getByText("brainstorming")).toBeInTheDocument());

    await user.type(screen.getByLabelText("Search skills"), "ef-core");
    expect(screen.queryByText("brainstorming")).not.toBeInTheDocument();
    expect(screen.getByText("optimizing-ef-core")).toBeInTheDocument();
  });

  it("shows an empty state when no skills are installed", async () => {
    renderWithProviders(<SkillsSection provider="anthropic" projectPath="/proj" />);
    await waitFor(() =>
      expect(screen.getByText(/no skills installed/i)).toBeInTheDocument(),
    );
  });
});
