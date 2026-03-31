import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { ipc, IPC_CHANNELS } from "@/lib/ipc";

interface TerminalOutputPayload {
  id: string;
  data: string;
}

interface InteractiveTerminalProps {
  projectPath: string;
}

/**
 * A fully interactive xterm.js terminal backed by a node-pty PTY in the
 * Electron main process.  Spawns a new shell session on mount and cleans
 * up the PTY when unmounted.
 */
export function InteractiveTerminal({ projectPath }: InteractiveTerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Refs so event-handler closures always see the latest values.
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    // ── Create xterm.js instance ─────────────────────────────────────────────
    const xterm = new Terminal({
      theme: {
        background: "#09090b",
        foreground: "#e4e4e7",
        cursor: "#a1a1aa",
        selectionBackground: "#3f3f46",
        black: "#18181b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
        brightBlack: "#3f3f46",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#f4f4f5",
      },
      fontFamily: '"GeistMono Nerd Font", "Geist Mono", "Cascadia Code", monospace',
      fontSize: 12,
      lineHeight: 1.4,
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    xterm.loadAddon(fitAddon);
    xterm.open(containerRef.current);
    fitAddon.fit();

    xtermRef.current = xterm;
    fitAddonRef.current = fitAddon;

    // ── Spawn PTY in main process ────────────────────────────────────────────
    let disposed = false;

    ipc.terminalCreate(projectPath).then((id) => {
      if (disposed) {
        // Component unmounted before PTY was ready — clean it up immediately.
        ipc.terminalClose(id);
        return;
      }

      terminalIdRef.current = id;

      // Forward user keystrokes to the PTY.
      xterm.onData((data) => ipc.terminalInput(id, data));
    });

    // ── Subscribe to PTY output ──────────────────────────────────────────────
    const handleOutput = (payload: unknown) => {
      const { id, data } = payload as TerminalOutputPayload;
      if (id === terminalIdRef.current) {
        xterm.write(data);
      }
    };

    window.electronAPI.on(IPC_CHANNELS.TERMINAL_OUTPUT, handleOutput);

    // ── Resize observer — keeps PTY cols/rows in sync ────────────────────────
    const ro = new ResizeObserver(() => {
      fitAddon.fit();
      const id = terminalIdRef.current;
      if (id) ipc.terminalResize(id, xterm.cols, xterm.rows);
    });

    ro.observe(containerRef.current);

    // ── Cleanup ──────────────────────────────────────────────────────────────
    return () => {
      disposed = true;
      ro.disconnect();
      window.electronAPI.off(IPC_CHANNELS.TERMINAL_OUTPUT, handleOutput);
      if (terminalIdRef.current) {
        ipc.terminalClose(terminalIdRef.current);
        terminalIdRef.current = null;
      }
      xterm.dispose();
    };
    // Intentionally exclude projectPath from deps: we want the terminal to
    // persist across re-renders; re-creating on path change is a separate concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="h-full w-full bg-[#09090b] overflow-hidden">
      <div ref={containerRef} className="h-full w-full p-1" />
    </div>
  );
}
