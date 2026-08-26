// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { McpMarketplacePanel } from "@/components/settings/sections/McpMarketplacePanel";

const ENTRY_NO_CONFIG = {
  id: "memory",
  name: "Memory",
  description: "A persistent knowledge graph the agent can read and write across turns.",
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-memory"],
  tags: ["productivity"],
  installed: false,
};

const ENTRY_WITH_CONFIG = {
  id: "github",
  name: "GitHub",
  description: "Manage GitHub repos, issues, and pull requests.",
  transport: "stdio" as const,
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  env: { GITHUB_PERSONAL_ACCESS_TOKEN: "{{githubToken}}" },
  tags: ["dev-tools"],
  configFields: [
    { key: "githubToken", label: "GitHub personal access token", required: true, secret: true },
  ],
  installed: false,
};

function renderPanel(props: Partial<React.ComponentProps<typeof McpMarketplacePanel>> = {}) {
  const onOpenChange = vi.fn();
  const onChanged = vi.fn();
  return {
    onOpenChange,
    onChanged,
    ...renderWithProviders(
      <McpMarketplacePanel open onOpenChange={onOpenChange} onChanged={onChanged} {...props} />,
    ),
  };
}

describe("McpMarketplacePanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.mcpMarketplaceList).mockResolvedValue([
      ENTRY_NO_CONFIG,
      ENTRY_WITH_CONFIG,
    ]);
    vi.mocked(window.electronAPI.mcpMarketplaceInstall).mockResolvedValue({
      probe: { connected: true, tools: ["read", "write"], durationMs: 12 },
    });
    vi.mocked(window.electronAPI.mcpMarketplaceUninstall).mockResolvedValue(undefined);
  });

  it("loads and lists catalog entries when opened", async () => {
    renderPanel();
    expect(await screen.findByText("Memory")).toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(window.electronAPI.mcpMarketplaceList).toHaveBeenCalledTimes(1);
  });

  it("filters entries by search query", async () => {
    renderPanel();
    await screen.findByText("Memory");

    await userEvent.type(screen.getByPlaceholderText("Search servers…"), "github");
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();
  });

  it("filters entries by tag chip", async () => {
    renderPanel();
    await screen.findByText("Memory");

    await userEvent.click(screen.getByRole("button", { name: "dev-tools" }));
    expect(screen.queryByText("Memory")).not.toBeInTheDocument();
    expect(screen.getByText("GitHub")).toBeInTheDocument();

    // Clicking the same chip again clears the filter.
    await userEvent.click(screen.getByRole("button", { name: "dev-tools" }));
    expect(screen.getByText("Memory")).toBeInTheDocument();
  });

  it("installs an entry with no config fields directly, with no intermediate form", async () => {
    renderPanel();
    await screen.findByText("Memory");

    // Memory (no configFields) is the first card; GitHub (has configFields) is the second.
    await userEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);

    await waitFor(() =>
      expect(window.electronAPI.mcpMarketplaceInstall).toHaveBeenCalledWith({
        entryId: "memory",
        values: {},
      }),
    );
    expect(await screen.findByText("Installed")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/2 tools/)).toBeInTheDocument();
  });

  it("expands a config form for an entry with required fields and blocks install until filled", async () => {
    renderPanel();
    await screen.findByText("GitHub");

    const installButtons = screen.getAllByRole("button", { name: "Install" });
    await userEvent.click(installButtons[1]); // GitHub is the second card

    const tokenInput = await screen.findByLabelText(/GitHub personal access token/);
    const confirmButtons = screen.getAllByRole("button", { name: "Install" });
    const confirmButton = confirmButtons[confirmButtons.length - 1];
    expect(confirmButton).toBeDisabled();

    await userEvent.type(tokenInput, "ghp_secret");
    expect(confirmButton).not.toBeDisabled();

    await userEvent.click(confirmButton);
    await waitFor(() =>
      expect(window.electronAPI.mcpMarketplaceInstall).toHaveBeenCalledWith({
        entryId: "github",
        values: { githubToken: "ghp_secret" },
      }),
    );
  });

  it("shows an inline error when install fails", async () => {
    vi.mocked(window.electronAPI.mcpMarketplaceInstall).mockRejectedValue(new Error("spawn npx ENOENT"));
    renderPanel();
    await screen.findByText("Memory");

    await userEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);
    expect(await screen.findByText(/spawn npx ENOENT/)).toBeInTheDocument();
  });

  it("calls onChanged after a successful install", async () => {
    const { onChanged } = renderPanel();
    await screen.findByText("Memory");

    await userEvent.click(screen.getAllByRole("button", { name: "Install" })[0]);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });

  it("uninstalls an already-installed entry", async () => {
    vi.mocked(window.electronAPI.mcpMarketplaceList).mockResolvedValue([
      { ...ENTRY_NO_CONFIG, installed: true },
    ]);
    const { onChanged } = renderPanel();
    await screen.findByText("Memory");

    await userEvent.click(screen.getByRole("button", { name: "Uninstall Memory" }));

    await waitFor(() =>
      expect(window.electronAPI.mcpMarketplaceUninstall).toHaveBeenCalledWith({ entryId: "memory" }),
    );
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });
});
