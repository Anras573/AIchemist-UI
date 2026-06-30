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
    // Wait for the project config to load before switching tabs. The
    // `[projectId]` effect in ProjectSettingsContent runs `setTab("general")` +
    // loadConfig(); clicking Approval before that effect settles can revert the
    // tab to General (the source of the CI flake).
    await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);
    fireEvent.click(await screen.findByRole("button", { name: /approval/i }));
    await waitFor(() => {
      expect(screen.getByText("Filesystem")).toBeInTheDocument();
      expect(screen.getByText("Shell")).toBeInTheDocument();
      expect(screen.getByText("Web")).toBeInTheDocument();
    });
  });

  it("preserves approval rules for categories not shown in the UI when editing a policy", async () => {
    const cfg = makeConfig({
      approval_mode: "custom",
      approval_rules: [
        { tool_category: "filesystem", policy: "risky_only" },
        // A "custom"-category rule has no row in the UI; editing another
        // category must not drop it.
        { tool_category: "custom", policy: "always" },
      ],
    });
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(cfg);
    vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

    renderProjectSection(makeProject("proj-cust", cfg));
    // Wait for config to load before switching tabs — see the note above; the
    // setTab("general") in the [projectId] effect can otherwise reset the
    // Approval click on slow CI, so the policy rows never render.
    await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);
    fireEvent.click(await screen.findByRole("button", { name: /approval/i }));

    const fsSelect = await screen.findByLabelText("Filesystem approval policy");
    fireEvent.change(fsSelect, { target: { value: "always" } });

    await waitFor(() =>
      expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
        "proj-cust",
        expect.objectContaining({
          approval_rules: expect.arrayContaining([
            { tool_category: "custom", policy: "always" },
            { tool_category: "filesystem", policy: "always" },
          ]),
        }),
      ),
    );
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

    // Text fields autosave through useAutosave's 500ms debounce — give the
    // assertion ample headroom so it isn't sensitive to scheduler delays.
    await waitFor(
      () =>
        expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
          "proj-42",
          expect.objectContaining({ model: "claude-opus-4-5" }),
        ),
      { timeout: 3000 },
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

  it("persists the normalized Anthropic default when the model is cleared", async () => {
    vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(
      makeConfig({ model: "claude-opus-4-5" }),
    );
    vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

    renderProjectSection(makeProject("proj-norm", makeConfig({ model: "claude-opus-4-5" })));
    const modelInput = await screen.findByDisplayValue("claude-opus-4-5");

    // Clearing the model on an Anthropic project autosaves the normalized
    // default — and that is exactly the value autosave tracks for undo.
    fireEvent.change(modelInput, { target: { value: "" } });

    await waitFor(
      () =>
        expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
          "proj-norm",
          expect.objectContaining({ provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL }),
        ),
      { timeout: 3000 },
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

describe("SettingsView — Skills & Agents sections", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.getCopilotAgents).mockResolvedValue([]);
  });

  it("lists skills via the app default provider when no session is active", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DEFAULT_PROVIDER: "copilot",
    } as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Skills" }));

    await waitFor(() =>
      expect(window.electronAPI.listSkills).toHaveBeenCalledWith("", "copilot"),
    );
  });

  it("lists Copilot agents via the app default provider when no session is active", async () => {
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({
      AICHEMIST_DEFAULT_PROVIDER: "copilot",
    } as never);

    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Agents" }));

    await waitFor(() =>
      expect(window.electronAPI.getCopilotAgents).toHaveBeenCalledWith(""),
    );
  });
});

describe("SettingsView — search + focus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.settingsRead).mockResolvedValue({} as never);
    // Park the hub on a section with no heavy IPC so the search/nav assertions
    // don't depend on provider probes.
    useProjectStore.setState({
      settingsOpen: true,
      settingsSection: { scope: "app", id: "appearance" },
    });
  });

  it("focuses the search input once settings have loaded", async () => {
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    const searchInput = await screen.findByLabelText("Search settings");
    await waitFor(() => expect(searchInput).toHaveFocus());
  });

  it("does not steal focus back to the search box on an autosave settings update", async () => {
    vi.mocked(window.electronAPI.settingsWrite).mockResolvedValue(undefined as never);
    // Advanced has editable fields whose autosave calls setSettings() — exactly
    // the update that must NOT re-trigger the one-time search autofocus.
    useProjectStore.setState({ settingsSection: { scope: "app", id: "advanced" } });
    renderWithProviders(<SettingsView onClose={vi.fn()} />);

    // Wait for the one-time load autofocus to fire (it focuses the search box when
    // `settings` first loads). Focusing the select before that races the async
    // settingsRead: if it resolves after select.focus(), the autofocus steals
    // focus to the search box (the source of this test's CI flakiness). Once it
    // has fired, its `didAutofocus` guard prevents it ever re-stealing focus —
    // which is exactly the behavior under test.
    const searchInput = await screen.findByLabelText("Search settings");
    await waitFor(() => expect(searchInput).toHaveFocus());

    const select = (await screen.findByLabelText("Default Provider")) as HTMLSelectElement;
    select.focus();
    expect(select).toHaveFocus();

    // Changing the select autosaves (settingsWrite → setSettings), updating the
    // `settings` state the focus effect depends on.
    fireEvent.change(select, { target: { value: "ollama" } });
    await waitFor(() => expect(window.electronAPI.settingsWrite).toHaveBeenCalled());

    // Focus stays on the field the user was editing, not the search box.
    expect(select).toHaveFocus();
    expect(screen.getByLabelText("Search settings")).not.toHaveFocus();
  });

  it("filters nav rows by a field keyword, not just the section label", async () => {
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    const searchInput = await screen.findByLabelText("Search settings");

    // "api key" is a field inside Providers & Keys — its label has no "key"
    // string match on its own beyond the literal label, but "theme" proves the
    // keyword index surfaces a section whose label doesn't contain the query.
    fireEvent.change(searchInput, { target: { value: "theme" } });

    // Appearance owns the "theme" keyword and stays visible.
    expect(screen.getByRole("button", { name: "Appearance" })).toBeInTheDocument();
    // Unrelated sections are filtered out.
    expect(screen.queryByRole("button", { name: "MCP Servers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skills" })).not.toBeInTheDocument();
  });

  it("surfaces the Providers & Keys section for an 'api key' query", async () => {
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    const searchInput = await screen.findByLabelText("Search settings");

    fireEvent.change(searchInput, { target: { value: "api key" } });

    expect(screen.getByRole("button", { name: "Providers & Keys" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Appearance" })).not.toBeInTheDocument();
  });

  it("shows a no-match empty state when nothing matches the query", async () => {
    renderWithProviders(<SettingsView onClose={vi.fn()} />);
    const searchInput = await screen.findByLabelText("Search settings");

    fireEvent.change(searchInput, { target: { value: "zzzznomatch" } });

    expect(screen.getByText(/No settings match/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Appearance" })).not.toBeInTheDocument();
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
