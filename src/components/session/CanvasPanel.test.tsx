// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { CanvasPanel } from "./CanvasPanel";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { CanvasListItem, Project } from "@/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/proj",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    ...overrides,
  };
}

function activateProject() {
  useProjectStore.getState().addProject(makeProject());
  useProjectStore.getState().setActiveProject("proj-1");
}

function makeCanvas(overrides: Partial<CanvasListItem> = {}): CanvasListItem {
  return {
    id: "canvas-1",
    project_id: "proj-1",
    definition: "kanban",
    title: "Release board",
    state: { columns: [] },
    revision: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    attached: false,
    ...overrides,
  };
}

describe("CanvasPanel", () => {
  beforeEach(() => {
    activateProject();
  });

  it("shows the empty state when the project has no canvases", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([]);
    renderWithProviders(<CanvasPanel />);

    await waitFor(() => {
      expect(screen.getByText(/No canvases yet/)).toBeInTheDocument();
    });
  });

  it("opens the first canvas and shows its running status", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([makeCanvas()]);
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({
      state: { columns: [] },
      revision: 0,
      status: "running",
    });

    renderWithProviders(<CanvasPanel />);

    await waitFor(() => {
      expect(window.electronAPI.canvasOpen).toHaveBeenCalledWith("canvas-1");
    });
    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
    // No restart affordance while healthy.
    expect(screen.queryByRole("button", { name: /restart/i })).not.toBeInTheDocument();
  });

  it("shows a crashed status with a Restart button, which calls CANVAS_RESTART", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([makeCanvas()]);
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({
      state: { columns: [] },
      revision: 0,
      status: "crashed",
    });
    vi.mocked(window.electronAPI.canvasRestart).mockResolvedValue({
      state: { columns: [] },
      revision: 1,
      status: "running",
    });

    renderWithProviders(<CanvasPanel />);

    const restartButton = await screen.findByRole("button", { name: /restart/i });
    expect(screen.getByText("Crashed")).toBeInTheDocument();

    restartButton.click();

    await waitFor(() => {
      expect(window.electronAPI.canvasRestart).toHaveBeenCalledWith("canvas-1");
    });
    await waitFor(() => {
      expect(screen.getByText("Running")).toBeInTheDocument();
    });
  });

  it("shows an errored status with a Restart button", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([makeCanvas()]);
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({
      state: null,
      revision: 0,
      status: "errored",
    });

    renderWithProviders(<CanvasPanel />);

    await screen.findByText("Error");
    expect(screen.getByRole("button", { name: /restart/i })).toBeInTheDocument();
  });

  it("shows the attach toggle only when a session is active, and calls CANVAS_ATTACH", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([makeCanvas({ attached: false })]);
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({
      state: null,
      revision: 0,
      status: "running",
    });

    const { rerender } = renderWithProviders(<CanvasPanel />);
    await waitFor(() => expect(window.electronAPI.canvasOpen).toHaveBeenCalled());
    expect(screen.queryByText("Attached to this session")).not.toBeInTheDocument();

    useSessionStore.getState().setActiveSession("session-1");
    vi.mocked(window.electronAPI.canvasAttach).mockResolvedValue({ attached: true });
    rerender(<CanvasPanel />);

    const checkbox = await screen.findByLabelText("Attached to this session");
    checkbox.click();

    await waitFor(() => {
      expect(window.electronAPI.canvasAttach).toHaveBeenCalledWith("session-1", "canvas-1", true);
    });
  });

  it("creates a new canvas via the New canvas form", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([]);
    vi.mocked(window.electronAPI.canvasCreate).mockResolvedValue({
      id: "canvas-new",
      project_id: "proj-1",
      definition: "kanban",
      title: "New board",
      state: null,
      revision: 0,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({
      state: null,
      revision: 0,
      status: "starting",
    });

    renderWithProviders(<CanvasPanel />);
    await waitFor(() => expect(screen.getByText(/No canvases yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "New canvas" }));
    const titleInput = await screen.findByPlaceholderText(/Title/);
    const definitionSelect = await screen.findByLabelText("Canvas definition");

    fireEvent.change(titleInput, { target: { value: "New board" } });
    // "kanban" is already selected by default (the only built-in definition).
    expect(definitionSelect).toHaveValue("kanban");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(window.electronAPI.canvasCreate).toHaveBeenCalledWith({
        projectId: "proj-1",
        definition: "kanban",
        title: "New board",
      });
    });
  });
});
