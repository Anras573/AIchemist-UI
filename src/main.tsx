import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { CanvasPopout } from "@/components/session/CanvasPopout";
import { initTheme } from "@/lib/hooks/useTheme";

// Apply saved theme before first render to prevent a light-flash
initTheme();

// A pop-out canvas window (#248) loads this same bundle with ?canvasPopout=<id>.
const params = new URLSearchParams(window.location.search);
const popoutCanvasId = params.get("canvasPopout");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {popoutCanvasId ? (
      <CanvasPopout canvasId={popoutCanvasId} definition={params.get("definition") ?? ""} />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
