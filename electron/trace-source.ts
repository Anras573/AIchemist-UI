/**
 * Resolve where a session's transcript lives (Claude SDK jsonl, Copilot
 * events.jsonl, or AIchemist's own native transcript) and load it as
 * TraceSpans. Shared by GET_TRACES (electron/ipc/trace-handlers.ts) and the
 * usage-ledger backfill (electron/usage-backfill.ts) — both need to locate a
 * session's transcript the same way and turn it into the same span shape.
 */

import type { Database } from "better-sqlite3";
import type { TraceSpan } from "../src/types/index";
import {
  findTranscriptFile,
  parseTranscript,
  transcriptToSpans,
} from "./claude-transcript";
import {
  findCopilotEventsFile,
  parseCopilotEvents,
  copilotEventsToSpans,
} from "./copilot-transcript";
import {
  findNativeTranscriptFile,
  parseNativeTranscript,
  nativeEventsToSpans,
} from "./native-transcript";
import { parseProviderSessionState } from "./agent/provider-session-store";
import { getProjectConfig } from "./projects";

export type TraceSource =
  | { kind: "claude"; projectPath: string; sdkSessionId: string; provider: "anthropic" }
  | { kind: "copilot"; copilotSessionId: string; provider: "copilot" }
  | { kind: "native"; sessionId: string; provider: "ollama" | "openai-compatible" | "codex" }
  | null;

/**
 * Resolve which transport produced a session's transcript, plus the provider
 * that ran it. Prefers the unified `provider_state` blob, falling back to the
 * legacy sdk_session_id / copilot_session_id columns for sessions that last
 * ran before that migration. Self-driven providers (Ollama, OpenAI-compatible,
 * Codex) have no SDK session id — resolved by the session's effective
 * provider (locked at creation, falling back to the project default for
 * legacy null-provider sessions) rather than file existence, so a caller can
 * bind before the first turn has written anything.
 */
export function resolveTraceSource(db: Database, sessionId: string): TraceSource {
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
  const state = parseProviderSessionState(row.providerState);
  const sdkSessionId = state.claude?.sdkSessionId ?? row.sdkSessionId;
  const copilotSessionId = state.copilot?.sessionId ?? row.copilotSessionId;
  if (sdkSessionId) {
    return { kind: "claude", projectPath: row.workspacePath, sdkSessionId, provider: "anthropic" };
  }
  if (copilotSessionId) {
    return { kind: "copilot", copilotSessionId, provider: "copilot" };
  }
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
    return { kind: "native", sessionId, provider: effectiveProvider };
  }
  return null;
}

/** Load and parse a session's transcript into TraceSpans. Returns `[]` when no transcript is resolvable or found on disk. */
export async function loadTranscriptSpans(db: Database, sessionId: string): Promise<TraceSpan[]> {
  const src = resolveTraceSource(db, sessionId);
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
