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

  it("shows a \"Definition missing\" state and a Delete button when the instance's definition isn't discovered anywhere", async () => {
    // The default canvasListDefinitions mock only lists "kanban" — an
    // instance referencing a since-deleted definition has nothing to match.
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([makeCanvas({ definition: "deleted-canvas" })]);
    vi.mocked(window.electronAPI.canvasDelete).mockResolvedValue({ ok: true });

    renderWithProviders(<CanvasPanel />);

    await screen.findByText("Definition missing");
    expect(screen.getByText(/deleted-canvas/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /delete this instance/i }));

    await waitFor(() => {
      expect(window.electronAPI.canvasDelete).toHaveBeenCalledWith("canvas-1");
    });
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
    // "kanban" is already selected by default (the only built-in definition),
    // keyed as "<tier>:<id>" so a same-id project entry can't collide with it.
    expect(definitionSelect).toHaveValue("builtin:kanban");

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(window.electronAPI.canvasCreate).toHaveBeenCalledWith({
        projectId: "proj-1",
        definition: "kanban",
        title: "New board",
      });
    });
  });

  it("re-discovers definitions when New canvas opens, so a definition the agent just wrote appears (#229)", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([]);
    const entry = (id: string) => ({
      id,
      tier: "builtin" as const,
      path: `/app/${id}`,
      manifest: { name: id, description: id, version: 1, server: "server.mjs", ui: "ui/index.html" },
    });
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({ definitions: [entry("kanban")], errors: [] });

    renderWithProviders(<CanvasPanel />);
    await waitFor(() => expect(screen.getByText(/No canvases yet/)).toBeInTheDocument());

    // The agent writes a new definition while the panel stays mounted.
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [entry("kanban"), entry("fresh-board")],
      errors: [],
    });
    fireEvent.click(screen.getByRole("button", { name: "New canvas" }));

    const select = await screen.findByLabelText<HTMLSelectElement>("Canvas definition");
    await waitFor(() =>
      expect(Array.from(select.options).map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining("fresh-board")]))
    );
  });

  it("distinguishes a same-id project and built-in definition in the picker, and creates the selected one (review regression on #237)", async () => {
    vi.mocked(window.electronAPI.canvasList).mockResolvedValue([]);
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [
        {
          id: "kanban",
          tier: "project",
          path: "/proj/.agents/canvases/kanban",
          manifest: { name: "kanban", description: "Untrusted project override", version: 1, server: "server.mjs", ui: "ui/index.html" },
        },
        {
          id: "kanban",
          tier: "builtin",
          path: "/app/electron/canvas/builtin/kanban",
          manifest: { name: "kanban", description: "The real one", version: 1, server: "server.mjs", ui: "ui/index.html" },
        },
      ],
      errors: [],
    });
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

    renderWithProviders(<CanvasPanel />);
    await waitFor(() => expect(screen.getByText(/No canvases yet/)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "New canvas" }));
    const definitionSelect = await screen.findByLabelText<HTMLSelectElement>("Canvas definition");

    // Two distinct options exist (no silently-collapsed duplicate), and the
    // picker defaults to the always-trusted built-in entry rather than the
    // same-named project one (which still needs a trust prompt, #227).
    const optionValues = Array.from(definitionSelect.options).map((o) => o.value);
    expect(optionValues).toEqual(["project:kanban", "builtin:kanban"]);
    expect(definitionSelect).toHaveValue("builtin:kanban");

    fireEvent.change(screen.getByPlaceholderText(/Title/), { target: { value: "New board" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      // The runnable built-in "kanban" is created, not the untrusted project one.
      expect(window.electronAPI.canvasCreate).toHaveBeenCalledWith({
        projectId: "proj-1",
        definition: "kanban",
        title: "New board",
      });
    });
  });
});
