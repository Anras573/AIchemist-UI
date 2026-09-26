import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { CanvasFrame } from "./CanvasFrame";

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("iframe not found");
  return iframe;
}

/** Dispatches a `message` event on `window` as if it came from `source`. */
function postFromWindow(source: Window, data: unknown) {
  window.dispatchEvent(new MessageEvent("message", { data, source }));
}

describe("CanvasFrame", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a sandboxed iframe pointed at the canvas protocol, with no allow-same-origin", () => {
    const { container } = renderWithProviders(
      <CanvasFrame canvasId="c1" definition="kanban" state={null} revision={0} />
    );
    const iframe = getIframe(container);
    expect(iframe.src).toBe("aichemist-canvas://c1/");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
  });

  it("ignores a message whose source isn't this iframe's contentWindow", async () => {
    const { container } = renderWithProviders(
      <CanvasFrame canvasId="c1" definition="kanban" state={{ a: 1 }} revision={1} />
    );
    const iframe = getIframe(container);
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    // A different window (e.g. another iframe, or a compromised message
    // spoofing attempt) sending "ready" must not be treated as this
    // iframe's handshake.
    const otherIframe = document.createElement("iframe");
    document.body.appendChild(otherIframe);
    postFromWindow(otherIframe.contentWindow!, { type: "ready" });

    await new Promise((r) => setTimeout(r, 0));
    expect(postSpy).not.toHaveBeenCalled();
    otherIframe.remove();
  });

  it("ignores a validly-sourced message with an invalid shape", async () => {
    const { container } = renderWithProviders(
      <CanvasFrame canvasId="c1" definition="kanban" state={{ a: 1 }} revision={1} />
    );
    const iframe = getIframe(container);
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    postFromWindow(iframe.contentWindow!, { type: "not-a-real-type" });
    await new Promise((r) => setTimeout(r, 0));

    expect(postSpy).not.toHaveBeenCalled();
  });

  it("posts the current state into the iframe once it completes the ready handshake", async () => {
    const { container } = renderWithProviders(
      <CanvasFrame canvasId="c1" definition="kanban" state={{ columns: [] }} revision={3} />
    );
    const iframe = getIframe(container);
    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");

    postFromWindow(iframe.contentWindow!, { type: "ready" });

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith({ type: "state", state: { columns: [] }, revision: 3 }, "*");
    });
  });

  it("relays a validated UI message to the host via canvasUiMessage", async () => {
    const { container } = renderWithProviders(
      <CanvasFrame canvasId="c1" definition="kanban" state={null} revision={0} />
    );
    const iframe = getIframe(container);

    postFromWindow(iframe.contentWindow!, { type: "ready" });
    postFromWindow(iframe.contentWindow!, { type: "message", message: { type: "move", id: "7" } });

    await waitFor(() => {
      expect(window.electronAPI.canvasUiMessage).toHaveBeenCalledWith("c1", { type: "move", id: "7" });
    });
  });

  it("re-posts a pushed message into the iframe when its seq changes", async () => {
    const { container, rerender } = render(
      <CanvasFrame canvasId="c1" definition="kanban" state={null} revision={0} />
    );
    const iframe = getIframe(container);
    postFromWindow(iframe.contentWindow!, { type: "ready" });
    await waitFor(() => expect(iframe.contentWindow).toBeTruthy());

    const postSpy = vi.spyOn(iframe.contentWindow!, "postMessage");
    rerender(
      <CanvasFrame
        canvasId="c1"
        definition="kanban"
        state={null}
        revision={0}
        message={{ message: { ping: 1 }, seq: 1 }}
      />
    );

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith({ type: "message", message: { ping: 1 } }, "*");
    });
  });
});
