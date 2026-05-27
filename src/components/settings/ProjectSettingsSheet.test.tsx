import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet";
import type { ProjectConfig } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-5";

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
    ...overrides,
  };
}

const onClose = vi.fn();

function renderSheet(projectId = "proj-1") {
  return renderWithProviders(
    <ProjectSettingsSheet projectId={projectId} onClose={onClose} />
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("ProjectSettingsSheet", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("loading", () => {
    it("shows loading state while config is being fetched", () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockReturnValue(new Promise(() => {}));
      renderSheet();
      expect(screen.getByText("Loading…")).toBeDefined();
    });

    it("shows error and retry button when load fails", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockRejectedValue(new Error("disk error"));
      renderSheet();
      await waitFor(() => expect(screen.getByText(/disk error/)).toBeDefined());
      expect(screen.getByRole("button", { name: /retry/i })).toBeDefined();
    });
  });

  describe("General tab", () => {
    it("renders provider and model from loaded config", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig({ model: "claude-opus-4-5" }));
      renderSheet();
      await waitFor(() => expect(screen.getByDisplayValue("claude-opus-4-5")).toBeDefined());
      expect(screen.getByDisplayValue("Anthropic (Claude)")).toBeDefined();
    });

    it("clears model when provider is changed", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig({ model: DEFAULT_ANTHROPIC_MODEL }));
      renderSheet();
      await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);

      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });

      await waitFor(() => {
        expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
      });
    });

    it("restores Anthropic default model when switching back to Anthropic", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig({ model: "claude-opus-4-5" }));
      renderSheet();
      await screen.findByDisplayValue("claude-opus-4-5");

      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "ollama" } });
      await waitFor(() => {
        expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe("");
      });

      fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "anthropic" } });
      await waitFor(() => {
        expect((screen.getByLabelText("Model") as HTMLInputElement).value).toBe(DEFAULT_ANTHROPIC_MODEL);
      });
    });
  });

  describe("Approval tab", () => {
    beforeEach(() => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
    });

    it("shows per-rule rows when approval_mode is custom", async () => {
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: /approval/i }));
      await waitFor(() => {
        expect(screen.getByText("Filesystem")).toBeDefined();
        expect(screen.getByText("Shell")).toBeDefined();
        expect(screen.getByText("Web")).toBeDefined();
      });
    });

    it("hides per-rule rows when approval_mode is switched to 'all'", async () => {
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: /approval/i }));

      const modeSelect = await screen.findByDisplayValue(/Custom/);
      fireEvent.change(modeSelect, { target: { value: "all" } });

      await waitFor(() => {
        expect(screen.queryByText("Filesystem")).toBeNull();
        expect(screen.queryByText("Shell")).toBeNull();
      });
    });

    it("hides per-rule rows when approval_mode is switched to 'none'", async () => {
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: /approval/i }));

      const modeSelect = await screen.findByDisplayValue(/Custom/);
      fireEvent.change(modeSelect, { target: { value: "none" } });

      await waitFor(() => {
        expect(screen.queryByText("Filesystem")).toBeNull();
      });
    });
  });

  describe("Save", () => {
    it("calls saveProjectConfig with the updated config", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig({ model: "claude-haiku-4-5" }));
      vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

      renderSheet("proj-42");
      await screen.findByDisplayValue("claude-haiku-4-5");

      fireEvent.change(screen.getByDisplayValue("claude-haiku-4-5"), { target: { value: "claude-opus-4-5" } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() =>
        expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
          "proj-42",
          expect.objectContaining({ model: "claude-opus-4-5" })
        )
      );
    });

    it("shows 'Saved' confirmation after successful save", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

      renderSheet();
      await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    });

    it("shows inline error message when save fails", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      vi.mocked(window.electronAPI.saveProjectConfig).mockRejectedValue(new Error("write failed"));

      renderSheet();
      await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => expect(screen.getByText(/write failed/)).toBeDefined());
    });

    it("saves Anthropic default model when Anthropic model input is empty", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      vi.mocked(window.electronAPI.saveProjectConfig).mockResolvedValue(undefined);

      renderSheet("proj-99");
      await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);

      fireEvent.change(screen.getByLabelText("Model"), { target: { value: "" } });
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() =>
        expect(window.electronAPI.saveProjectConfig).toHaveBeenCalledWith(
          "proj-99",
          expect.objectContaining({ provider: "anthropic", model: DEFAULT_ANTHROPIC_MODEL })
        )
      );
    });
  });

  describe("Close behaviour", () => {
    it("calls onClose when Escape is pressed", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      renderSheet();
      await screen.findByDisplayValue(DEFAULT_ANTHROPIC_MODEL);

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalled();
    });

    it("calls onClose when the ✕ button is clicked", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      renderSheet();
      fireEvent.click(await screen.findByRole("button", { name: /close/i }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
