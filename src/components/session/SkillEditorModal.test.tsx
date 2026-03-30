import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SkillEditorModal } from "@/components/session/SkillEditorModal";
import type { SkillInfo } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EDITABLE_SKILL: SkillInfo = {
  name: "ai-elements",
  description: "UI components for AI apps",
  path: "/home/user/project/.agents/skills/ai-elements",
};

function renderModal(
  props: Partial<React.ComponentProps<typeof SkillEditorModal>> = {}
) {
  const defaults = {
    skill: null as SkillInfo | null,
    projectPath: "/home/user/project",
    open: true,
    onClose: vi.fn(),
    onSaved: vi.fn(),
  };
  return { ...renderWithProviders(<SkillEditorModal {...defaults} {...props} />), ...defaults, ...props };
}

// ─── New skill mode ───────────────────────────────────────────────────────────

describe("SkillEditorModal — new skill", () => {
  it("shows 'New Skill' title", () => {
    renderModal({ skill: null });
    expect(screen.getByText("New Skill")).toBeInTheDocument();
  });

  it("shows name input, scope selector, and content textarea", () => {
    renderModal({ skill: null });
    expect(screen.getByPlaceholderText("my-skill")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/project/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Describe the capability/i)).toBeInTheDocument();
  });

  it("shows error when name is empty on create", async () => {
    renderModal({ skill: null });
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/skill name is required/i)).toBeInTheDocument();
  });

  it("shows error when name contains a space", async () => {
    renderModal({ skill: null });
    await userEvent.type(screen.getByPlaceholderText("my-skill"), "bad skill");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/must not contain spaces or slashes/i)).toBeInTheDocument();
  });

  it("shows error when name contains a slash", async () => {
    renderModal({ skill: null });
    await userEvent.type(screen.getByPlaceholderText("my-skill"), "bad/skill");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/must not contain spaces or slashes/i)).toBeInTheDocument();
  });

  it("calls ipc.createSkill and onSaved/onClose on successful create", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.createSkill).mockResolvedValue({ skillPath: "/home/user/project/.agents/skills/new-skill" });

    renderModal({ skill: null, onSaved, onClose });
    await userEvent.type(screen.getByPlaceholderText("my-skill"), "new-skill");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(window.electronAPI.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-skill", projectPath: "/home/user/project" })
      );
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows error when createSkill rejects", async () => {
    vi.mocked(window.electronAPI.createSkill).mockRejectedValue(new Error("disk full"));

    renderModal({ skill: null });
    await userEvent.type(screen.getByPlaceholderText("my-skill"), "new-skill");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to create skill/i)).toBeInTheDocument();
    });
  });

  it("passes selected scope to createSkill", async () => {
    vi.mocked(window.electronAPI.createSkill).mockResolvedValue({ skillPath: "" });

    renderModal({ skill: null });
    await userEvent.type(screen.getByPlaceholderText("my-skill"), "global-skill");
    await userEvent.selectOptions(screen.getByRole("combobox"), "Global");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(window.electronAPI.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "global" })
      );
    });
  });
});

// ─── Edit mode ────────────────────────────────────────────────────────────────

describe("SkillEditorModal — edit existing skill", () => {
  it("shows 'Edit Skill — <name>' title", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => {
      expect(screen.getByText("Edit Skill — ai-elements")).toBeInTheDocument();
    });
  });

  it("reads SKILL.md from skill path via ipc.readFile", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "---\nname: ai-elements\n---\nInstructions." });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => {
      expect(screen.getByDisplayValue(/instructions/i)).toBeInTheDocument();
    });
    expect(window.electronAPI.readFile).toHaveBeenCalledWith(
      `${EDITABLE_SKILL.path}/SKILL.md`
    );
  });

  it("shows error when readFile fails", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ error: "not found" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => {
      expect(screen.getByText(/could not read skill\.md/i)).toBeInTheDocument();
    });
  });

  it("displays skill path below the title", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => {
      expect(screen.getByText(new RegExp(EDITABLE_SKILL.path))).toBeInTheDocument();
    });
  });

  it("calls ipc.writeSkillFile and onSaved/onClose on save", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "original content" });
    vi.mocked(window.electronAPI.writeSkillFile).mockResolvedValue(undefined);

    renderModal({ skill: EDITABLE_SKILL, onSaved, onClose });
    await waitFor(() => screen.getByDisplayValue("original content"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(window.electronAPI.writeSkillFile).toHaveBeenCalledWith({
        skillPath: EDITABLE_SKILL.path,
        content: "original content",
      });
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows error when writeSkillFile rejects", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    vi.mocked(window.electronAPI.writeSkillFile).mockRejectedValue(new Error("permission denied"));

    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => screen.getByDisplayValue("body"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to save skill/i)).toBeInTheDocument();
    });
  });

  it("shows Delete button initially (not Confirm Delete)", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.queryByText(/confirm delete/i)).not.toBeInTheDocument();
  });

  it("first delete click shows 'Confirm Delete'", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.getByRole("button", { name: /confirm delete/i })).toBeInTheDocument();
  });

  it("second delete click calls ipc.deleteSkillDir and onSaved/onClose", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    vi.mocked(window.electronAPI.deleteSkillDir).mockResolvedValue(undefined);

    renderModal({ skill: EDITABLE_SKILL, onSaved, onClose });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => {
      expect(window.electronAPI.deleteSkillDir).toHaveBeenCalledWith(EDITABLE_SKILL.path);
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("does not show name input or scope selector in edit mode", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL });
    await waitFor(() => screen.getByText("Edit Skill — ai-elements"));
    expect(screen.queryByPlaceholderText("my-skill")).not.toBeInTheDocument();
  });
});

// ─── Read-only view ───────────────────────────────────────────────────────────

describe("SkillEditorModal — read-only view", () => {
  it("shows 'Skill — ai-elements' title (not 'Edit Skill')", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => {
      expect(screen.getByText("Skill — ai-elements")).toBeInTheDocument();
    });
    expect(screen.queryByText(/edit skill/i)).not.toBeInTheDocument();
  });

  it("shows a 'Close' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => screen.getByText("Skill — ai-elements"));
    expect(screen.getAllByRole("button", { name: /^close$/i }).length).toBeGreaterThan(0);
  });

  it("does NOT show a 'Save' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => screen.getByText("Skill — ai-elements"));
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("does NOT show a 'Delete' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => screen.getByText("Skill — ai-elements"));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("does NOT render a textarea", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => screen.getByText("Skill — ai-elements"));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("calls ipc.readFile with `${skill.path}/SKILL.md` to load content", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => {
      expect(window.electronAPI.readFile).toHaveBeenCalledWith(
        `${EDITABLE_SKILL.path}/SKILL.md`
      );
    });
  });

  it("displays the file path", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ skill: EDITABLE_SKILL, readOnly: true });
    await waitFor(() => {
      expect(screen.getByText(new RegExp(EDITABLE_SKILL.path))).toBeInTheDocument();
    });
  });
});
