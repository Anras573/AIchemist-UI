import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, ProjectConfig } from "@/types";
import { SettingsView } from "./SettingsView";

// Navigates SettingsView to the Providers section, where the OpenAI-compatible
// endpoints manager lives.
async function openProvidersSection() {
  renderWithProviders(<SettingsView onClose={vi.fn()} />);
  // settingsRead resolves async; wait for the nav to render, then click it.
  fireEvent.click(await screen.findByRole("button", { name: "Providers" }));
}

describe("SettingsView — Defaults: max tool rounds", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clamps an out-of-range value to the max before persisting and reflects it in the field", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Defaults" }));

    const input = (await screen.findByLabelText("Max tool rounds")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ AICHEMIST_MAX_TOOL_ROUNDS: "100" }),
      ),
    );
    // The field is corrected to the clamped value the app actually uses.
    await waitFor(() => expect(input.value).toBe("100"));
  });

  it("persists a valid in-range value unchanged", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Defaults" }));

    const input = (await screen.findByLabelText("Max tool rounds")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ AICHEMIST_MAX_TOOL_ROUNDS: "12" }),
      ),
    );
  });
});

// ── Project section ─────────────────────────────────────────────────────────
// The standalone ProjectSettingsSheet was retired in the settings hub overhaul;
// its ProjectSettingsContent body is now reached through the hub's PROJECT nav.
// These tests render SettingsView with the store pointed at the project section.

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-6";

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    provider: "anthropic",
    model: DEFAULT_ANTHROPIC_MODEL,
    approval_mode: "custom",
    approval_rules: [
      { tool_category: "filesystem", policy: "risky_only" },
      { tool_category: "shell", policy: "always" },
      { tool_category: "web", policy: "never" },
    ],
    custom_tools: [],
    allowed_tools: [],
    create_worktree_per_session: false,
    ...overrides,
  };
}

function makeProject(id = "proj-1", config = makeConfig()): Project {
  return { id, name: "My Project", path: "/tmp/proj", created_at: "2026-01-01", config };
}

// Configure the store so SettingsView renders the active project's settings.
function renderProjectSection(project = makeProject()) {
  useProjectStore.setState({
    projects: [project],
    activeProjectId: project.id,
    settingsOpen: true,
    settingsSection: { scope: "project", id: "general" },
  });
  return renderWithProviders(<SettingsView onClose={vi.fn()} />);
}

describe("SettingsView — Project section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);
  });

  it("renders provider and model from the active project's config", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(
      makeConfig({ model: "claude-opus-4-5" }),
    );
    renderProjectSection();
    await waitFor(() => expect(screen.getByDisplayValue("claude-opus-4-5")).toBeInTheDocument());
    expect(screen.getByDisplayValue("Anthropic (Claude)")).toBeInTheDocument();
  });

  it("clears the model when the provider is changed", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
    renderProjectSection();
    await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
    await waitFor(() =>
      expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(""),
    );
  });

  it("shows per-rule rows on the Approval tab when approval_mode is custom", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
    renderProjectSection();
    fireEvent.click(await screen.findByRole("button", { name: /approval/i }));
    await waitFor(() => {
      expect(screen.getByText("Filesystem")).toBeInTheDocument();
      expect(screen.getByText("Shell")).toBeInTheDocument();
      expect(screen.getByText("Web")).toBeInTheDocument();
    });
  });

  it("persists config changes via saveProjectConfig", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(
      makeConfig({ model: "claude-haiku-4-5" }),
    );
    vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

    renderProjectSection(makeProject("proj-42", makeConfig({ model: "claude-haiku-4-5" })));
    await screen.findByDisplayValue("claude-haiku-4-5");

    fireEvent.change(screen.getByDisplayValue("claude-haiku-4-5"), {
      target: { value: "claude-opus-4-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() =>
      expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
        "proj-42",
        expect.objectContaining({ model: "claude-opus-4-5" }),
      ),
    );
  });

  it("falls back to an empty-state message when no project is active", async () => {
    useProjectStore.setState({
      projects: [],
      activeProjectId: null,
      settingsOpen: true,
      settingsSection: { scope: "project", id: "general" },
    });
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    await waitFor(() =>
      expect(screen.getByText(/No active project selected/i)).toBeInTheDocument(),
    );
  });
});

describe("SettingsView — OpenAI-compatible endpoints error feedback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("surfaces a read failure instead of the empty state", async () => {
    vi.mocked(window.electronAPI.readOpenAiEndpoints).mockRejectedValue(
      new Error("EACCES: permission denied"),
    );

    await openProvidersSection();

    await waitFor(() =>
      expect(screen.getByText(/EACCES: permission denied/)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/No endpoints configured yet/)).not.toBeInTheDocument();
  });

  it("surfaces a delete failure when no form is open", async () => {
    vi.mocked(window.electronAPI.readOpenAiEndpoints).mockResolvedValue({
      local: { baseURL: "http://localhost:1234/v1" },
    });
    vi.mocked(window.electronAPI.deleteOpenAiEndpoint).mockRejectedValue(
      new Error("write failed"),
    );

    await openProvidersSection();

    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText(/write failed/)).toBeInTheDocument(),
    );
  });
});
