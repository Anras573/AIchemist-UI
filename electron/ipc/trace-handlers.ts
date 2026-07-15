import * as fs from "fs";
import * as path from "path";
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import type { Provider, TraceSpan } from "../../src/types/index";
import { resolveProjectDir, watchTranscript, type TranscriptWatcher } from "../claude-transcript";
import { watchCopilotTranscript, type CopilotTranscriptWatcher } from "../copilot-transcript";
import { watchNativeTranscript, type NativeTranscriptWatcher } from "../native-transcript";
import { handle } from "./handle";
import { resolveTraceSource, loadTranscriptSpans } from "../trace-source";
import { listMemoryFiles } from "../agent/memory";

export function registerTraceHandlers(db: Database, getMainWindow: () => BrowserWindow | null): void {
  const claudeWatchers = new Map<string, TranscriptWatcher>();
  const copilotWatchers = new Map<string, CopilotTranscriptWatcher>();
  const nativeWatchers = new Map<string, NativeTranscriptWatcher>();

  handle(CH.GET_TRACES, async (_event, sessionId?: string) => {
    if (!sessionId) return [];
    try {
      return await loadTranscriptSpans(db, sessionId);
    } catch {
      return [];
    }
  });

  handle(CH.LIST_MEMORY, async (_event, args: string | { projectPath: string; provider?: Provider }) => {
    // Accept a bare projectPath string for back-compat (treated as Claude),
    // exactly as LIST_SKILLS does.
    const projectPath = typeof args === "string" ? args : args.projectPath;
    const provider = typeof args === "string" ? undefined : args.provider;
    if (!projectPath) return { files: [] as Array<{ name: string; path: string }> };
    try {
      // The non-Claude providers (Ollama, OpenAI-compatible, Copilot, Codex) all
      // use AIchemist's own store at ~/.aichemist/memory/<cwd> — memory is
      // portable across providers for a project. Go through listMemoryFiles so the
      // memory module's safety checks (symlinked-dir-chain refusal, regular-file
      // filtering) apply — a raw readdir could surface symlinked .md entries that
      // READ_FILE would then follow to arbitrary paths.
      if (
        provider === "ollama" ||
        provider === "openai-compatible" ||
        provider === "copilot" ||
        provider === "codex"
      ) {
        return { files: listMemoryFiles(projectPath) };
      }
      // Only Claude has an SDK-owned store (under ~/.claude/projects/<cwd>/memory);
      // the bare-string / unset form is treated as Claude for back-compat. Any
      // other (unknown) provider returns empty rather than falling through, which
      // would surface Claude memory for a non-Claude caller.
      if (provider !== undefined && provider !== "anthropic") {
        return { files: [] };
      }
      const projectDir = await resolveProjectDir(projectPath);
      if (!projectDir) return { files: [] };
      const memDir = path.join(projectDir, "memory");
      let entries: fs.Dirent[];
      try {
        // withFileTypes + isFile() filters out symlinks (and dirs), mirroring
        // listMemoryFiles — otherwise a symlinked .md (e.g. secret.md -> /etc/passwd)
        // would surface here and READ_FILE (no path sandbox) would follow it.
        entries = await fs.promises.readdir(memDir, { withFileTypes: true });
      } catch {
        return { files: [] };
      }
      const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
        .map((name) => ({ name, path: path.join(memDir, name) }));
      return { files };
    } catch {
      return { files: [] };
    }
  });

  handle(CH.TRACE_BIND_TRANSCRIPT, (_event, sessionId: string) => {
    if (!sessionId) return { ok: false };
    if (
      claudeWatchers.has(sessionId) ||
      copilotWatchers.has(sessionId) ||
      nativeWatchers.has(sessionId)
    ) {
      return { ok: true };
    }

    const src = resolveTraceSource(db, sessionId);
    if (!src) return { ok: false, reason: "no-sdk-session-id" };

    const onUpdate = (spans: TraceSpan[]) => {
      const win = getMainWindow();
      if (!win) return;
      for (const span of spans) win.webContents.send(CH.SESSION_TRACE, span);
    };

    if (src.kind === "claude") {
      const watcher = watchTranscript(src.projectPath, src.sdkSessionId, sessionId, { onUpdate });
      claudeWatchers.set(sessionId, watcher);
    } else if (src.kind === "native") {
      const watcher = watchNativeTranscript(sessionId, { onUpdate });
      nativeWatchers.set(sessionId, watcher);
    } else {
      const watcher = watchCopilotTranscript(src.copilotSessionId, sessionId, { onUpdate });
      copilotWatchers.set(sessionId, watcher);
    }
    return { ok: true };
  });

  handle(CH.TRACE_UNBIND_TRANSCRIPT, (_event, sessionId: string) => {
    const a = claudeWatchers.get(sessionId);
    if (a) { a.close(); claudeWatchers.delete(sessionId); }
    const b = copilotWatchers.get(sessionId);
    if (b) { b.close(); copilotWatchers.delete(sessionId); }
    const c = nativeWatchers.get(sessionId);
    if (c) { c.close(); nativeWatchers.delete(sessionId); }
    return { ok: true };
  });
}
