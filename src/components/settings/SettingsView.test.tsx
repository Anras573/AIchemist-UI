import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SettingsView } from "./SettingsView";

// Navigates SettingsView to the Providers section, where the OpenAI-compatible
// endpoints manager lives.
async function openProvidersSection() {
  renderWithProviders(<SettingsView onClose={vi.fn()} />);
  // settingsRead resolves async; wait for the nav to render, then click it.
  fireEvent.click(await screen.findByRole("button", { name: "Providers" }));
}

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
