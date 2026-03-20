import "@testing-library/jest-dom/vitest";
import { beforeEach } from "vitest";
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
};

const initialProjectState = {
  projects: [],
  activeProjectId: null,
  settingsOpen: false,
};

beforeEach(() => {
  window.electronAPI = createElectronAPIMock();
  // Merge reset values — do NOT pass replace=true as that wipes action functions
  useSessionStore.setState(initialSessionState);
  useProjectStore.setState(initialProjectState);
  localStorage.clear();
});
