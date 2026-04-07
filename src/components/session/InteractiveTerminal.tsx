import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useIpc, IPC_CHANNELS } from "@/lib/ipc";
import {
  Terminal,
  TerminalHeader,
  TerminalTitle,
  TerminalActions,
  TerminalClearButton,
} from "@/components/ai-elements/terminal";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CheckIcon, CopyIcon } from "lucide-react";

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
  const ipc = useIpc();
  const containerRef = useRef<HTMLDivElement>(null);
  // Refs so event-handler closures always see the latest values.
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  // Accumulate PTY output since the last Enter — used by the copy button.
  const lastCommandOutputRef = useRef<string>("");
  const [copied, setCopied] = useState(false);

  const handleClear = () => {
    xtermRef.current?.clear();
    lastCommandOutputRef.current = "";
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(lastCommandOutputRef.current);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  useEffect(() => {
    if (!containerRef.current) return;

    // ── Create xterm.js instance ─────────────────────────────────────────────
    const xterm = new XTerm({
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

      // Forward user keystrokes to the PTY; reset the copy buffer on Enter.
      xterm.onData((data) => {
        if (data === "\r") lastCommandOutputRef.current = "";
        ipc.terminalInput(id, data);
      });
    });

    // ── Subscribe to PTY output ──────────────────────────────────────────────
    const handleOutput = (payload: unknown) => {
      const { id, data } = payload as TerminalOutputPayload;
      if (id === terminalIdRef.current) {
        xterm.write(data);
        lastCommandOutputRef.current += data;
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
    <Terminal output="" onClear={handleClear} className="h-full rounded-none border-0">
      <TerminalHeader>
        <TerminalTitle />
        <TerminalActions>
          <TooltipProvider delay={300}>
            <Tooltip>
              <TooltipTrigger>
                <Button
                  className="size-7 shrink-0 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                  onClick={handleCopy}
                  size="icon"
                  variant="ghost"
                >
                  {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy output since last command</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger>
                <TerminalClearButton />
              </TooltipTrigger>
              <TooltipContent>Clear terminal</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </TerminalActions>
      </TerminalHeader>
      <div ref={containerRef} className="flex-1 overflow-hidden p-1" />
    </Terminal>
  );
}
