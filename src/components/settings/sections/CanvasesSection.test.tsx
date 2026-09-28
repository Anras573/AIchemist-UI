import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { CanvasesSection } from "@/components/settings/sections/CanvasesSection";
import type { CanvasDiscoveryResult } from "@/types";

const KANBAN: CanvasDiscoveryResult["definitions"][number] = {
  id: "kanban",
  tier: "builtin",
  path: "/app/electron/canvas/builtin/kanban",
  manifest: {
    name: "kanban",
    description: "A kanban board with todo/doing/done columns.",
    version: 1,
    server: "server.mjs",
    ui: "ui/index.html",
  },
};

const PROJECT_BOARD: CanvasDiscoveryResult["definitions"][number] = {
  id: "board",
  tier: "project",
  path: "/proj/.agents/canvases/board",
  manifest: {
    name: "board",
    description: "A project-authored board.",
    version: 1,
    server: "server.mjs",
    ui: "ui/index.html",
  },
};

describe("CanvasesSection (hub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists discovered definitions, tagged by tier", async () => {
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [KANBAN],
      errors: [],
    });

    renderWithProviders(<CanvasesSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText("kanban")).toBeInTheDocument());
    expect(screen.getByText("built-in")).toBeInTheDocument();
    expect(window.electronAPI.canvasListDefinitions).toHaveBeenCalledWith({ projectId: "proj-1" });
  });

  it("flags an untrusted project-tier definition (#227)", async () => {
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [PROJECT_BOARD],
      errors: [],
    });
    vi.mocked(window.electronAPI.canvasTrustStatus).mockResolvedValue({
      definition: "board",
      path: "/proj/.agents/canvases/board",
      manifest: PROJECT_BOARD.manifest,
      dependencies: { names: [], hasPackageJson: false },
      contentHash: "hash",
      trusted: false,
      trustedAt: null,
    });

    renderWithProviders(<CanvasesSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText("board")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText("not trusted")).toBeInTheDocument());
  });

  it("shows a Revoke action for a trusted project-tier definition and revokes on click", async () => {
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [PROJECT_BOARD],
      errors: [],
    });
    vi.mocked(window.electronAPI.canvasTrustStatus).mockResolvedValue({
      definition: "board",
      path: "/proj/.agents/canvases/board",
      manifest: PROJECT_BOARD.manifest,
      dependencies: { names: [], hasPackageJson: false },
      contentHash: "hash",
      trusted: true,
      trustedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.mocked(window.electronAPI.canvasTrustRevoke).mockResolvedValue({ ok: true });

    renderWithProviders(<CanvasesSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText("trusted")).toBeInTheDocument());
    fireEvent.click(screen.getByText("Revoke"));

    await waitFor(() =>
      expect(window.electronAPI.canvasTrustRevoke).toHaveBeenCalledWith({ projectId: "proj-1", definition: "board" })
    );
  });

  it("shows manifest errors separately from valid definitions", async () => {
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({
      definitions: [KANBAN],
      errors: [
        { id: "broken", tier: "global", path: "/home/user/.aichemist/canvases/broken", reason: "name: name must not be empty" },
      ],
    });

    renderWithProviders(<CanvasesSection projectId="proj-1" />);

    await waitFor(() => expect(screen.getByText("kanban")).toBeInTheDocument());
    expect(screen.getByText("Manifest errors")).toBeInTheDocument();
    expect(screen.getByText("broken")).toBeInTheDocument();
    expect(screen.getByText(/name must not be empty/)).toBeInTheDocument();
  });

  it("shows an empty state when no definitions are found", async () => {
    vi.mocked(window.electronAPI.canvasListDefinitions).mockResolvedValue({ definitions: [], errors: [] });

    renderWithProviders(<CanvasesSection projectId="" />);

    await waitFor(() => expect(screen.getByText(/No canvas definitions found/)).toBeInTheDocument());
    expect(window.electronAPI.canvasListDefinitions).toHaveBeenCalledWith({ projectId: undefined });
  });
});
