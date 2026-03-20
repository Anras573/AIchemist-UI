import "@testing-library/jest-dom/vitest";
import { beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createElectronAPIMock } from "./mocks/electronAPI";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";

const initialSessionState = {
  sessions: {},
  activeSessionId: null,
  streamingText: {},
  liveToolCalls: {},
  pendingApprovals: {},
  terminalOutput: {},
  sessionAgents: {},
};

const initialProjectState = {
  projects: [],
  activeProjectId: null,
  settingsOpen: false,
};

afterEach(cleanup);

beforeEach(() => {
  window.electronAPI = createElectronAPIMock();
  // Merge reset values — do NOT pass replace=true as that wipes action functions
  useSessionStore.setState(initialSessionState);
  useProjectStore.setState(initialProjectState);
  localStorage.clear();

  // jsdom doesn't implement matchMedia — provide a stub
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true, // required so subsequent beforeEach calls can redefine it
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});
