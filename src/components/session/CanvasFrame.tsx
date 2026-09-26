import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { useIpc } from "@/lib/ipc";
import type { CanvasRelayedMessage } from "@/lib/store/useCanvasStore";

/**
 * Messages the sandboxed iframe (running `aichemist-canvas-client.js`,
 * `electron/canvas/client-script.ts`) may post to us. Anything else is
 * dropped — this is the untrusted side of the bridge, so every message is
 * validated before it's forwarded over IPC.
 */
const CanvasClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready") }),
  z.object({ type: z.literal("message"), message: z.unknown() }),
]);

/**
 * Renders a canvas instance's UI in a sandboxed `<iframe sandbox="allow-scripts">`
 * (deliberately no `allow-same-origin` — the iframe gets an opaque origin, so
 * it has no access to the host DOM, `localStorage`, or `window.electronAPI`)
 * loaded from `aichemist-canvas://<canvasId>/`. The protocol
 * (`electron/canvas/protocol.ts`) resolves `canvasId` to the instance's
 * definition and serves only files under its `ui/` folder, with a CSP that
 * blocks all network access — the UI stays inert; anything network- or
 * system-bound goes through the canvas's server.
 *
 * The bridge: iframe → `postMessage` → here (validated) → IPC
 * (`canvasUiMessage`) → main → the host's `onUiMessage`. And the reverse for
 * state/message pushes: `CanvasPanel` passes the latest `state`/`revision`/
 * `message` down as props (sourced from `useCanvasStore`, populated by
 * `CANVAS_EVENT`), and this component relays them into the iframe via
 * `postMessage` once the client script has completed its `ready` handshake.
 */
export function CanvasFrame({
  canvasId,
  definition,
  state,
  revision,
  message,
}: {
  canvasId: string;
  definition: string;
  state: unknown;
  revision: number;
  message?: CanvasRelayedMessage;
}) {
  const ipc = useIpc();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  // A fresh canvasId (switching instances) means a fresh iframe, so wait for
  // its own "ready" handshake again rather than posting into a stale one.
  useEffect(() => {
    setReady(false);
  }, [canvasId]);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // The one origin check that actually matters here: the iframe has an
      // opaque ("null") origin, so `event.origin` can't be compared — match
      // the window reference instead, exactly as the design calls for.
      const iframeWindow = iframeRef.current?.contentWindow;
      if (!iframeWindow || event.source !== iframeWindow) return;

      const parsed = CanvasClientMessageSchema.safeParse(event.data);
      if (!parsed.success) return;

      if (parsed.data.type === "ready") {
        setReady(true);
      } else {
        void ipc.canvasUiMessage(canvasId, parsed.data.message).catch((err) => {
          console.error(`[canvas] failed to relay UI message for ${canvasId}:`, err);
        });
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [canvasId, ipc]);

  useEffect(() => {
    if (!ready) return;
    iframeRef.current?.contentWindow?.postMessage({ type: "state", state, revision }, "*");
  }, [ready, state, revision]);

  useEffect(() => {
    if (!ready || !message) return;
    iframeRef.current?.contentWindow?.postMessage({ type: "message", message: message.message }, "*");
    // Only re-post on a genuinely new message (by seq) — `message` itself is a
    // fresh object every store update, but this effect should fire once per
    // relayed message, not once per unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, message?.seq]);

  // Sync the iframe's theme with the host app's — observes the same `dark`
  // class on <html> that useTheme() toggles, so no separate theme plumbing
  // is needed here.
  useEffect(() => {
    if (!ready) return;
    const postTheme = () => {
      const theme = document.documentElement.classList.contains("dark") ? "dark" : "light";
      iframeRef.current?.contentWindow?.postMessage({ type: "theme", theme }, "*");
    };
    postTheme();
    const observer = new MutationObserver(postTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, [ready]);

  return (
    <iframe
      ref={iframeRef}
      src={`aichemist-canvas://${canvasId}/`}
      sandbox="allow-scripts"
      title={`Canvas: ${definition}`}
      className="w-full h-full border-0 bg-background"
    />
  );
}
