import "@testing-library/jest-dom/vitest";
import { beforeEach, afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createElectronAPIMock } from "./mocks/electronAPI";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";

// Zustand's persist middleware calls createJSONStorage(() => window.localStorage)
// at store creation time (module evaluation). jsdom's localStorage requires a
// non-opaque origin (i.e. a real URL) to function, which isn't guaranteed in all
// vitest configurations. We provide a simple in-memory shim via vi.hoisted() so
// it is in place before any store modules are imported.
vi.hoisted(() => {
  const _store: Record<string, string> = {};
  const localStorageMock: Storage = {
    getItem: (key) => _store[key] ?? null,
    setItem: (key, value) => {
      _store[key] = String(value);
    },
    removeItem: (key) => {
      delete _store[key];
    },
    clear: () => {
      Object.keys(_store).forEach((k) => delete _store[k]);
    },
    get length() {
      return Object.keys(_store).length;
    },
    key: (i) => Object.keys(_store)[i] ?? null,
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: localStorageMock,
    writable: true,
    configurable: true,
  });
});

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
