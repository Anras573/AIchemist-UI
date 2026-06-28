import * as fs from "fs";
import * as path from "path";
import type { Database } from "better-sqlite3";
import type { BrowserWindow } from "electron";
import * as CH from "../ipc-channels";
import type { Provider, TraceSpan } from "../../src/types/index";
import {
  findTranscriptFile,
  parseTranscript,
  transcriptToSpans,
  watchTranscript,
  resolveProjectDir,
  type TranscriptWatcher,
} from "../claude-transcript";
import {
  findCopilotEventsFile,
  parseCopilotEvents,
  copilotEventsToSpans,
  watchCopilotTranscript,
  type CopilotTranscriptWatcher,
} from "../copilot-transcript";
import {
  findNativeTranscriptFile,
  parseNativeTranscript,
  nativeEventsToSpans,
  watchNativeTranscript,
  type NativeTranscriptWatcher,
} from "../native-transcript";
import { handle } from "./handle";
import { parseProviderSessionState } from "../agent/provider-session-store";
import { listMemoryFiles } from "../agent/memory";
import { getProjectConfig } from "../projects";

export function registerTraceHandlers(db: Database, getMainWindow: () => BrowserWindow | null): void {
  const claudeWatchers = new Map<string, TranscriptWatcher>();
  const copilotWatchers = new Map<string, CopilotTranscriptWatcher>();
  const nativeWatchers = new Map<string, NativeTranscriptWatcher>();

  type TraceSource =
    | { kind: "claude"; projectPath: string; sdkSessionId: string }
    | { kind: "copilot"; copilotSessionId: string }
    | { kind: "native"; sessionId: string }
    | null;

  function resolveTraceSource(sessionId: string): TraceSource {
    const row = db
      .prepare(
        `SELECT s.provider_state AS providerState,
                s.sdk_session_id AS sdkSessionId,
                s.copilot_session_id AS copilotSessionId,
                s.provider AS provider,
                s.project_id AS projectId,
               COALESCE(s.workspace_path, p.path) AS workspacePath
         FROM sessions s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?`
      )
      .get(sessionId) as
      | {
          providerState: string | null;
          sdkSessionId: string | null;
          copilotSessionId: string | null;
          provider: string | null;
          projectId: string;
          workspacePath: string;
        }
      | undefined;
    if (!row) return null;
    // Prefer the unified provider_state blob; fall back to the legacy columns
    // for sessions that last ran before the provider_state migration.
    const state = parseProviderSessionState(row.providerState);
    const sdkSessionId = state.claude?.sdkSessionId ?? row.sdkSessionId;
    const copilotSessionId = state.copilot?.sessionId ?? row.copilotSessionId;
    if (sdkSessionId) {
      return { kind: "claude", projectPath: row.workspacePath, sdkSessionId };
    }
    if (copilotSessionId) {
      return { kind: "copilot", copilotSessionId };
    }
    // Self-driven providers (Ollama, OpenAI-compatible, Codex) have no SDK
    // session id; they write their own transcript to
    // ~/.aichemist/traces/<sessionId>/.
    // Resolve by the session's effective provider (lock at creation, falling
    // back to the project default for legacy null-provider sessions) rather
    // than file existence — so binding the watcher before the first turn still
    // streams updates once events.jsonl appears. Project config lives on disk
    // (`<project>/.aichemist/config.json`), not a DB column, so read it via
    // getProjectConfig (best-effort: returns defaults on any failure).
    let effectiveProvider = row.provider ?? undefined;
    if (!effectiveProvider) {
      try {
        effectiveProvider = getProjectConfig(db, row.projectId).provider;
      } catch {
        effectiveProvider = "anthropic";
      }
    }
    if (
      effectiveProvider === "ollama" ||
      effectiveProvider === "openai-compatible" ||
      effectiveProvider === "codex"
    ) {
      return { kind: "native", sessionId };
    }
    return null;
  }

  async function loadTranscriptSpans(sessionId: string): Promise<TraceSpan[]> {
    const src = resolveTraceSource(sessionId);
    if (!src) return [];
    if (src.kind === "claude") {
      const file = await findTranscriptFile(src.projectPath, src.sdkSessionId);
      if (!file) return [];
      const entries = await parseTranscript(file);
      return transcriptToSpans(entries, { sessionId, sdkSessionId: src.sdkSessionId });
    }
    if (src.kind === "native") {
      const file = findNativeTranscriptFile(src.sessionId);
      if (!file) return [];
      const events = await parseNativeTranscript(file);
      return nativeEventsToSpans(events, { sessionId });
    }
    const file = await findCopilotEventsFile(src.copilotSessionId);
    if (!file) return [];
    const events = await parseCopilotEvents(file);
    return copilotEventsToSpans(events, { sessionId, copilotSessionId: src.copilotSessionId });
  }

  handle(CH.GET_TRACES, async (_event, sessionId?: string) => {
    if (!sessionId) return [];
    try {
      return await loadTranscriptSpans(sessionId);
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
      // The non-Claude providers (Ollama, OpenAI-compatible, Copilot) all use
      // AIchemist's own store at ~/.aichemist/memory/<cwd> — memory is portable
      // across providers for a project. Go through listMemoryFiles so the memory
      // module's safety checks (symlinked-dir-chain refusal, regular-file
      // filtering) apply — a raw readdir could surface symlinked .md entries that
      // READ_FILE would then follow to arbitrary paths.
      if (
        provider === "ollama" ||
        provider === "openai-compatible" ||
        provider === "copilot"
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

    const src = resolveTraceSource(sessionId);
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
