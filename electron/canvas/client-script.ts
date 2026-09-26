/**
 * Source for `aichemist-canvas-client.js`, served by the `aichemist-canvas://`
 * protocol (`protocol.ts`) for every canvas — app-owned code, not part of any
 * definition's `ui/` folder. Gives canvas authors `canvas.onState(fn)`,
 * `canvas.onMessage(fn)`, `canvas.send(msg)`, plus the handshake and
 * light/dark theme sync with `CanvasFrame` (the renderer-side half of the
 * bridge, `src/components/session/CanvasFrame.tsx`).
 *
 * Plain ES5-ish JS (no build step) since it's served byte-for-byte to a
 * sandboxed iframe with an opaque origin — `window.parent` is the only peer
 * it ever talks to, matched by `CanvasFrame` via `event.source ===
 * iframe.contentWindow`, never by origin (which is "null" for this iframe).
 */
export const CANVAS_CLIENT_SCRIPT_SOURCE = `(function () {
  "use strict";

  var stateListeners = [];
  var messageListeners = [];
  var latestState = null;
  var latestRevision = 0;
  var haveState = false;

  function applyTheme(theme) {
    var root = document.documentElement;
    root.setAttribute("data-theme", theme);
    root.style.colorScheme = theme;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || typeof data !== "object") return;

    if (data.type === "state") {
      haveState = true;
      latestState = data.state;
      latestRevision = data.revision;
      stateListeners.forEach(function (fn) {
        try {
          fn(data.state, data.revision);
        } catch (err) {
          console.error("[canvas] onState listener threw:", err);
        }
      });
    } else if (data.type === "message") {
      messageListeners.forEach(function (fn) {
        try {
          fn(data.message);
        } catch (err) {
          console.error("[canvas] onMessage listener threw:", err);
        }
      });
    } else if (data.type === "theme") {
      applyTheme(data.theme);
    }
  });

  window.canvas = {
    onState: function (fn) {
      stateListeners.push(fn);
      if (haveState) fn(latestState, latestRevision);
      return function () {
        stateListeners = stateListeners.filter(function (f) {
          return f !== fn;
        });
      };
    },
    onMessage: function (fn) {
      messageListeners.push(fn);
      return function () {
        messageListeners = messageListeners.filter(function (f) {
          return f !== fn;
        });
      };
    },
    send: function (message) {
      window.parent.postMessage({ type: "message", message: message }, "*");
    },
    getState: function () {
      return latestState;
    },
  };

  window.parent.postMessage({ type: "ready" }, "*");
})();
`;
