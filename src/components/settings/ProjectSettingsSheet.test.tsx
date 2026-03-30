import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { ProjectSettingsSheet } from "./ProjectSettingsSheet";
import type { ProjectConfig } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
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
      await screen.findByDisplayValue("claude-sonnet-4-5");
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => expect(screen.getByText("Saved")).toBeDefined());
    });

    it("shows inline error message when save fails", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      vi.mocked(window.electronAPI.saveProjectConfig).mockRejectedValue(new Error("write failed"));

      renderSheet();
      await screen.findByDisplayValue("claude-sonnet-4-5");
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

      await waitFor(() => expect(screen.getByText(/write failed/)).toBeDefined());
    });
  });

  describe("Close behaviour", () => {
    it("calls onClose when Escape is pressed", async () => {
      vi.mocked(window.electronAPI.getProjectConfig).mockResolvedValue(makeConfig());
      renderSheet();
      await screen.findByDisplayValue("claude-sonnet-4-5");

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

