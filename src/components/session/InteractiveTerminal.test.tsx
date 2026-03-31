import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { render, act } from "@testing-library/react";
import { InteractiveTerminal } from "./InteractiveTerminal";
import { IPC_CHANNELS } from "@/lib/ipc";

// ── jsdom stubs ───────────────────────────────────────────────────────────────

// jsdom does not implement ResizeObserver
beforeAll(() => {
  global.ResizeObserver = vi.fn().mockImplementation(function () {
    return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
  });
});

// ── Mock xterm.js — jsdom has no canvas so the real Terminal would throw ──────

const mockXterm = {
  loadAddon: vi.fn(),
  open: vi.fn(),
  onData: vi.fn(),
  write: vi.fn(),
  dispose: vi.fn(),
  cols: 80,
  rows: 24,
};

vi.mock("@xterm/xterm", () => ({
  // Must be a real function (not an arrow function) so `new Terminal()` works
  Terminal: vi.fn().mockImplementation(function () { return mockXterm; }),
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () { return { fit: vi.fn() }; }),
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

// ── Helpers ───────────────────────────────────────────────────────────────────

const PROJECT_PATH = "/home/user/my-project";
const TERMINAL_ID = "test-terminal-id";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("InteractiveTerminal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.terminalCreate).mockResolvedValue(TERMINAL_ID);
  });

  it("renders a container element", () => {
    const { container } = render(
      <InteractiveTerminal projectPath={PROJECT_PATH} />
    );
    expect(container.firstChild).toBeInTheDocument();
  });

  it("calls terminalCreate with the project path on mount", async () => {
    render(<InteractiveTerminal projectPath={PROJECT_PATH} />);
    await act(async () => {});
    expect(window.electronAPI.terminalCreate).toHaveBeenCalledWith(PROJECT_PATH);
  });

  it("subscribes to TERMINAL_OUTPUT on mount", () => {
    render(<InteractiveTerminal projectPath={PROJECT_PATH} />);
    const channels = vi.mocked(window.electronAPI.on).mock.calls.map(([ch]) => ch);
    expect(channels).toContain(IPC_CHANNELS.TERMINAL_OUTPUT);
  });

  it("calls terminalClose and removes the event listener on unmount", async () => {
    const { unmount } = render(
      <InteractiveTerminal projectPath={PROJECT_PATH} />
    );
    await act(async () => {});

    unmount();

    expect(window.electronAPI.terminalClose).toHaveBeenCalledWith(TERMINAL_ID);
    expect(window.electronAPI.off).toHaveBeenCalledWith(
      IPC_CHANNELS.TERMINAL_OUTPUT,
      expect.any(Function)
    );
  });

  it("writes incoming TERMINAL_OUTPUT to xterm when the id matches", async () => {
    render(<InteractiveTerminal projectPath={PROJECT_PATH} />);
    await act(async () => {});

    const [[, listener]] = vi.mocked(window.electronAPI.on).mock.calls.filter(
      ([ch]) => ch === IPC_CHANNELS.TERMINAL_OUTPUT
    );

    act(() => {
      listener({ id: TERMINAL_ID, data: "hello\r\n" });
    });

    expect(mockXterm.write).toHaveBeenCalledWith("hello\r\n");
  });

  it("ignores TERMINAL_OUTPUT events for other terminal ids", async () => {
    render(<InteractiveTerminal projectPath={PROJECT_PATH} />);
    await act(async () => {});

    const [[, listener]] = vi.mocked(window.electronAPI.on).mock.calls.filter(
      ([ch]) => ch === IPC_CHANNELS.TERMINAL_OUTPUT
    );

    act(() => {
      listener({ id: "some-other-id", data: "ignored" });
    });

    expect(mockXterm.write).not.toHaveBeenCalled();
  });
});
