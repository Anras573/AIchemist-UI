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
