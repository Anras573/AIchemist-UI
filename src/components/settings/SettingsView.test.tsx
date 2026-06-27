import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, ProjectConfig } from "@/types";
import { SettingsView } from "./SettingsView";

// Navigates SettingsView to the Providers & Keys section, where the
// OpenAI-compatible endpoints manager lives (inside the OpenAI-compatible card).
async function openProvidersSection() {
  renderWithProviders(<SettingsView onClose={vi.fn()} />);
  // settingsRead resolves async; wait for the nav to render, then click it.
  fireEvent.click(await screen.findByRole("button", { name: "Providers & Keys" }));
}

describe("SettingsView — Advanced: max tool rounds (autosave)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.settingsWrite).mockResolvedValue(undefined as never);
  });

  it("clamps an out-of-range value to the max before persisting and reflects it in the field", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));

    const input = (await screen.findByLabelText("Max tool rounds")) as HTMLInputElement;
    // No Save button — the field autosaves (debounced) on change.
    fireEvent.change(input, { target: { value: "9999" } });
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();

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
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));

    const input = (await screen.findByLabelText("Max tool rounds")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12" } });

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ AICHEMIST_MAX_TOOL_ROUNDS: "12" }),
      ),
    );
  });

  it("autosaves the default provider immediately on change and offers undo", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DEFAULT_PROVIDER: "anthropic",
    } as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Advanced" }));

    const select = (await screen.findByLabelText("Default Provider")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ollama" } });

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ AICHEMIST_DEFAULT_PROVIDER: "ollama" }),
      ),
    );

    // Saved ✓ + Undo affordance appears; undo re-persists the previous value.
    const undo = await screen.findByRole("button", { name: "Undo" });
    fireEvent.click(undo);
    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenLastCalledWith(
        expect.objectContaining({ AICHEMIST_DEFAULT_PROVIDER: "anthropic" }),
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

  it("autosaves config changes via saveProjectConfig (no Save button)", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(
      makeConfig({ model: "claude-haiku-4-5" }),
    );
    vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

    renderProjectSection(makeProject("proj-42", makeConfig({ model: "claude-haiku-4-5" })));
    await screen.findByDisplayValue("claude-haiku-4-5");

    // No manual Save button — editing a field autosaves (debounced for text).
    expect(screen.queryByRole("button", { name: /^save$/i })).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("claude-haiku-4-5"), {
      target: { value: "claude-opus-4-5" },
    });

    await waitFor(() =>
      expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
        "proj-42",
        expect.objectContaining({ model: "claude-opus-4-5" }),
      ),
    );
  });

  it("autosaves immediately when the provider changes", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
    vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

    renderProjectSection(makeProject("proj-7"));
    await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);

    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });

    // Selects commit immediately (not debounced) and clear the model.
    await waitFor(() =>
      expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
        "proj-7",
        expect.objectContaining({ provider: "ollama", model: "" }),
      ),
    );
  });

  it("shows inheritance ghost text against the app default provider", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DEFAULT_PROVIDER: "anthropic",
    } as never);
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());

    renderProjectSection();
    // Project provider matches the app default → "Matches the app default" hint.
    await waitFor(() =>
      expect(screen.getByText(/Matches the app default \(Anthropic \(Claude\)\)/i)).toBeInTheDocument(),
    );
  });

  it("flags an overridden provider in the inheritance ghost text", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DEFAULT_PROVIDER: "ollama",
    } as never);
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());

    renderProjectSection();
    // Project is Anthropic but the app default is Ollama → override hint.
    await waitFor(() =>
      expect(screen.getByText(/App default: Ollama — this project overrides it\./i)).toBeInTheDocument(),
    );
  });

  it("offers a project switcher listing every project and switches the active one", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());

    const projA = makeProject("proj-a", makeConfig());
    const projB: Project = { id: "proj-b", name: "Second Project", path: "/tmp/b", created_at: "2026-01-02", config: makeConfig() };
    useProjectStore.setState({
      projects: [projA, projB],
      activeProjectId: projA.id,
      settingsOpen: true,
      settingsSection: { scope: "project", id: "general" },
    });
    renderWithProviders(<SettingsView onClose={vi.fn()} />);

    const switcher = (await screen.findByLabelText("Active project")) as HTMLSelectElement;
    expect(switcher.value).toBe("proj-a");
    // Both projects are reachable from the switcher.
    expect(screen.getByRole("option", { name: "My Project" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Second Project" })).toBeInTheDocument();

    fireEvent.change(switcher, { target: { value: "proj-b" } });
    // Switching makes the chosen project active and loads its config.
    await waitFor(() => expect(useProjectStore.getState().activeProjectId).toBe("proj-b"));
    await waitFor(() =>
      expect(window.electronAPI.getProjectConfig).toHaveBeenCalledWith("proj-b"),
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

  it("shows a loading message when activeProjectId is set but projects haven't loaded", async () => {
    // Persisted activeProjectId can resolve before the async projects list.
    useProjectStore.setState({
      projects: [],
      activeProjectId: "proj-pending",
      settingsOpen: true,
      settingsSection: { scope: "project", id: "general" },
    });
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    // Both the nav ("Loading projects…") and the content body ("Loading
    // project…") report the pending state.
    await waitFor(() =>
      expect(screen.getByText("Loading project…")).toBeInTheDocument(),
    );
    expect(screen.getByText("Loading projects…")).toBeInTheDocument();
    expect(screen.queryByText(/No active project/i)).not.toBeInTheDocument();
  });

  it("falls back to the default section title on an unknown app section id", async () => {
    useProjectStore.setState({
      settingsOpen: true,
      settingsSection: { scope: "app", id: "does-not-exist" },
    });
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    // Header shows a stable "Settings" title rather than going blank, and the
    // API Keys body (the safe default section) renders.
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument(),
    );
    expect(screen.getByLabelText("Anthropic API Key")).toBeInTheDocument();
  });
});

describe("SettingsView — Providers & Keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);
    vi.mocked(window.electronAPI.settingsWrite).mockResolvedValue(undefined as never);
    vi.mocked(window.electronAPI.readOpenAiEndpoints).mockResolvedValue({});
    vi.mocked(window.electronAPI.probeProviders).mockResolvedValue({
      anthropic: { ok: true },
      copilot: { ok: false, reason: "GITHUB_TOKEN not set in ~/.aichemist/.env" },
      ollama: { ok: true },
      "openai-compatible": { ok: false, reason: "No endpoints configured" },
      codex: { ok: false, reason: "Invalid API key" },
    } as never);
  });

  it("disabling a provider writes AICHEMIST_DISABLED_PROVIDERS and re-probes", async () => {
    await openProvidersSection();

    const toggle = await screen.findByRole("switch", { name: "Enable Ollama" });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ AICHEMIST_DISABLED_PROVIDERS: "ollama" }),
      ),
    );
    // Connection-affecting change forces a fresh probe.
    await waitFor(() =>
      expect(window.electronAPI.probeProviders).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      ),
    );
  });

  it("autosaves the Anthropic API key (debounced) and force-probes after", async () => {
    await openProvidersSection();

    const input = await screen.findByLabelText("Anthropic API Key");
    fireEvent.change(input, { target: { value: "sk-ant-test" } });

    await waitFor(() =>
      expect(window.electronAPI.settingsWrite).toHaveBeenCalledWith(
        expect.objectContaining({ ANTHROPIC_API_KEY: "sk-ant-test" }),
      ),
    );
    await waitFor(() =>
      expect(window.electronAPI.probeProviders).toHaveBeenCalledWith(
        expect.objectContaining({ force: true }),
      ),
    );
  });

  it("shows a per-provider probe badge reflecting the probe result", async () => {
    await openProvidersSection();
    // Codex has an invalid key in the mocked probe → Invalid key badge.
    expect(await screen.findByLabelText("Status: Invalid key")).toBeInTheDocument();
  });

  it("shows a Disabled badge for a disabled provider (not the loading state)", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DISABLED_PROVIDERS: "ollama",
    } as never);
    vi.mocked(window.electronAPI.probeProviders).mockResolvedValue({
      anthropic: { ok: true },
      copilot: { ok: true },
      ollama: { ok: false, reason: "Disabled in settings" },
      "openai-compatible": { ok: true },
      codex: { ok: true },
    } as never);

    await openProvidersSection();

    expect(await screen.findByLabelText("Status: Disabled")).toBeInTheDocument();
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
