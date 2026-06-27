// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { McpServersSection } from "@/components/settings/sections/McpServersSection";

describe("McpServersSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.mcpReadConfig).mockResolvedValue({
      context7: { type: "stdio", command: "npx", args: ["-y", "@context7/mcp"] },
    });
    vi.mocked(window.electronAPI.mcpProbeManaged).mockResolvedValue([
      {
        name: "context7",
        command: "npx -y @context7/mcp",
        transport: "stdio",
        connected: true,
        status: "Connected",
        source: "aichemist",
        tools: ["search", "fetch"],
      },
    ]);
  });

  it("loads the AIchemist scope and shows live health per row", async () => {
    renderWithProviders(<McpServersSection projectPath="/home/user/proj" />);

    // The configured server loads into the form.
    expect(await screen.findByDisplayValue("context7")).toBeInTheDocument();
    expect(window.electronAPI.mcpReadConfig).toHaveBeenCalledWith(
      expect.objectContaining({ scope: "aichemist-global" }),
    );

    // The managed-server probe surfaces connection + tool-count health.
    await waitFor(() => expect(window.electronAPI.mcpProbeManaged).toHaveBeenCalled());
    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/2 tools/)).toBeInTheDocument();
  });

  it("re-probes health when the refresh button is clicked", async () => {
    renderWithProviders(<McpServersSection projectPath="/home/user/proj" />);
    await screen.findByDisplayValue("context7");
    await waitFor(() => expect(window.electronAPI.mcpProbeManaged).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByLabelText("Refresh health"));
    await waitFor(() => expect(window.electronAPI.mcpProbeManaged).toHaveBeenCalledTimes(2));
  });

  it("saves edited config via mcpWriteConfig", async () => {
    renderWithProviders(<McpServersSection projectPath="/home/user/proj" />);
    await screen.findByDisplayValue("context7");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(window.electronAPI.mcpWriteConfig).toHaveBeenCalledWith(
        expect.objectContaining({ scope: "aichemist-global" }),
      ),
    );
  });

  it("shows a server's probe error inline", async () => {
    vi.mocked(window.electronAPI.mcpProbeManaged).mockResolvedValue([
      {
        name: "context7",
        command: "npx -y @context7/mcp",
        transport: "stdio",
        connected: false,
        status: "Failed",
        source: "aichemist",
        error: "spawn npx ENOENT",
      },
    ]);

    renderWithProviders(<McpServersSection projectPath="/home/user/proj" />);
    await screen.findByDisplayValue("context7");

    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText(/spawn npx ENOENT/)).toBeInTheDocument();
  });
});
