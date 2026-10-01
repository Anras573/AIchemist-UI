import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useCanvasStore } from "@/lib/store/useCanvasStore";
import { CanvasPopout } from "./CanvasPopout";

vi.mock("./CanvasFrame", () => ({
  CanvasFrame: ({ canvasId, state, revision }: { canvasId: string; state: unknown; revision: number }) => (
    <div data-testid="frame" data-canvas={canvasId} data-revision={revision}>
      {JSON.stringify(state)}
    </div>
  ),
}));

/** The listener CanvasPopout registered for CANVAS_EVENT via window.electronAPI.on. */
function canvasEventListener(): (payload: unknown) => void {
  const call = vi.mocked(window.electronAPI.on).mock.calls.find(([channel]) => channel === "canvas:event");
  if (!call) throw new Error("no canvas:event listener registered");
  return call[1] as (payload: unknown) => void;
}

describe("CanvasPopout", () => {
  beforeEach(() => {
    useCanvasStore.setState({ stateByCanvas: {}, revisionByCanvas: {}, statusByCanvas: {}, lastMessageByCanvas: {}, reloadNonceByCanvas: {} });
    vi.mocked(window.electronAPI.canvasOpen).mockResolvedValue({ state: { cards: 1 }, revision: 3, status: "running" });
  });

  it("calls canvasOpen on mount and hydrates state and revision from the result", async () => {
    const { getByTestId } = renderWithProviders(<CanvasPopout canvasId="c1" definition="kanban" />);
    expect(window.electronAPI.canvasOpen).toHaveBeenCalledWith("c1");
    await waitFor(() => expect(getByTestId("frame").dataset.revision).toBe("3"));
    expect(getByTestId("frame").textContent).toBe('{"cards":1}');
    expect(useCanvasStore.getState().statusByCanvas["c1"]).toBe("running");
  });

  it("applies a CANVAS_EVENT state push for its own canvas and ignores other canvases", async () => {
    const { getByTestId } = renderWithProviders(<CanvasPopout canvasId="c1" definition="kanban" />);
    await waitFor(() => expect(getByTestId("frame").dataset.revision).toBe("3"));
    const listener = canvasEventListener();

    act(() => listener({ canvasId: "other", kind: "state", state: { x: 1 }, revision: 99 }));
    expect(getByTestId("frame").dataset.revision).toBe("3");

    act(() => listener({ canvasId: "c1", kind: "state", state: { cards: 2 }, revision: 4 }));
    expect(getByTestId("frame").dataset.revision).toBe("4");
    expect(getByTestId("frame").textContent).toBe('{"cards":2}');
  });

  it("calls canvasClose on unmount", async () => {
    const { unmount, getByTestId } = renderWithProviders(<CanvasPopout canvasId="c1" definition="kanban" />);
    await waitFor(() => getByTestId("frame"));
    unmount();
    expect(window.electronAPI.canvasClose).toHaveBeenCalledWith("c1");
  });
});
