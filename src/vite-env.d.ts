/// <reference types="vite/client" />

// Expose the typed ElectronAPI surface injected by the preload script.
import type { ElectronAPI } from "../electron/preload";

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
