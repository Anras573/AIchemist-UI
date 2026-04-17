/**
 * Copilot CLI session-state parser + live watcher.
 *
 * Copilot CLI writes a structured event log per session at
 *   ~/.copilot/session-state/<copilot-session-id>/events.jsonl
 *
 * Each line is a structured event with a type + data + timestamp.
 * Types we care about for tracing:
 *   - session.start               → selectedModel, cwd
 *   - session.resume              → selectedModel (override across restarts)
 *   - assistant.turn_start        → starts a turn (turnId)
 *   - assistant.turn_end          → ends a turn (turnId)
 *   - tool.execution_start        → tool call begins (toolCallId, toolName, arguments)
 *   - tool.execution_complete     → tool call ends (toolCallId, success, result, toolTelemetry)
 *   - assistant.message           → per-message outputTokens + reasoningText
 *
 * This mirrors electron/claude-transcript.ts — same incremental-reader +
 * directory-watch approach, different event shapes.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TraceSpan } from "../src/types/index";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CopilotEvent {
  type: string;
  id?: string;
  timestamp?: string;
  parentId?: string | null;
  data?: Record<string, unknown>;
}

// ── Paths ──────────────────────────────────────────────────────────────────────

export function copilotSessionStateRoot(): string {
  return path.join(os.homedir(), ".copilot", "session-state");
}

export function copilotEventsPath(copilotSessionId: string): string {
  return path.join(copilotSessionStateRoot(), copilotSessionId, "events.jsonl");
}

export async function findCopilotEventsFile(copilotSessionId: string): Promise<string | null> {
  const p = copilotEventsPath(copilotSessionId);
  try {
    await fsp.access(p);
    return p;
  } catch {
    return null;
  }
}

// ── Incremental parser ─────────────────────────────────────────────────────────

export interface CopilotEventsReader {
  path: string;
  readAll(): Promise<CopilotEvent[]>;
  readIncremental(): Promise<{ newEntries: CopilotEvent[]; didReset: boolean }>;
  reset(): void;
}

export function createCopilotEventsReader(filePath: string): CopilotEventsReader {
  let offset = 0;
  let buffer = "";
  const entries: CopilotEvent[] = [];

  async function pull(): Promise<{ newEntries: CopilotEvent[]; didReset: boolean }> {
    let didReset = false;
    let size = 0;
    try { size = (await fsp.stat(filePath)).size; }
    catch { return { newEntries: [], didReset: false }; }

    if (size < offset) {
      offset = 0;
      buffer = "";
      entries.length = 0;
      didReset = true;
    }
    if (size === offset) return { newEntries: [], didReset };

    const fd = await fsp.open(filePath, "r");
    try {
      const len = size - offset;
      const buf = Buffer.alloc(len);
      await fd.read(buf, 0, len, offset);
      offset = size;
      buffer += buf.toString("utf8");
    } finally {
      await fd.close();
    }

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    const newOnes: CopilotEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { newOnes.push(JSON.parse(line) as CopilotEvent); }
      catch { /* skip malformed */ }
    }
    entries.push(...newOnes);
    return { newEntries: newOnes, didReset };
  }

  return {
    path: filePath,
    async readAll() { await pull(); return [...entries]; },
    async readIncremental() { return pull(); },
    reset() { offset = 0; buffer = ""; entries.length = 0; },
  };
}

export async function parseCopilotEvents(filePath: string): Promise<CopilotEvent[]> {
  let raw: string;
  try { raw = await fsp.readFile(filePath, "utf8"); }
  catch { return []; }
  const out: CopilotEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line) as CopilotEvent); }
    catch { /* skip */ }
  }
  return out;
}

// ── Spans synthesis ────────────────────────────────────────────────────────────

function truncatePreview(s: string, lines = 5, maxLen = 800): string {
  if (!s) return "";
  const split = s.split("\n");
  const head = split.slice(0, lines).join("\n");
  const omitted = split.length - lines;
  const trimmed = head.length > maxLen ? head.slice(0, maxLen) + "…" : head;
  return omitted > 0 ? `${trimmed}\n… (+${omitted} more lines)` : trimmed;
}

function extractToolResultText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const r = result as {
    content?: string;
    detailedContent?: string;
    contents?: Array<{ type: string; text?: string; exitCode?: number }>;
  };
  const terminal = r.contents?.find((c) => c.type === "terminal");
  if (terminal?.text) return terminal.text;
  return r.detailedContent ?? r.content ?? "";
}

export interface CopilotSpanOptions {
  sessionId: string;           // app session id
  copilotSessionId: string;    // copilot sdk session id
}

/**
 * Build TraceSpans from a copilot events.jsonl event list.
 *
 * Turns are anchored at `user.message.interactionId` — Copilot emits a
 * cascade of inner `assistant.turn_start/end` pairs per user message (one
 * per tool-call batch), all sharing the same `interactionId`. Grouping by
 * interactionId yields one user-visible turn per user prompt, which wraps
 * all the tool calls + reasoning that answered it.
 *
 * - Turn start = first event carrying the interactionId (user.message or
 *   assistant.turn_start).
 * - Turn end   = when a subsequent interactionId appears (previous turn is
 *   finalized to "success"), or the event stream ends.
 * - Tool spans + assistant.messages attach to the currently-active turn.
 */
export function copilotEventsToSpans(
  events: CopilotEvent[],
  opts: CopilotSpanOptions
): TraceSpan[] {
  const { sessionId, copilotSessionId } = opts;

  let model: string | undefined;

  const spans: TraceSpan[] = [];
  const turnByInteraction = new Map<string, TraceSpan>();
  const toolById = new Map<string, TraceSpan>();
  let currentInteractionId: string | null = null;
  let currentTurnSpanId: string | null = null;

  const turnSpanId = (interactionId: string) =>
    `turn:copilot:${copilotSessionId}:${interactionId}`;
  const toolSpanId = (toolCallId: string) => `tool:${toolCallId}`;

  // When an interaction rolls forward (new user.message or new interactionId
  // observed on assistant.turn_start), finalize the previous turn.
  const finalizePrevious = () => {
    if (!currentInteractionId) return;
    const prev = turnByInteraction.get(currentInteractionId);
    if (prev && prev.status === "running") prev.status = "success";
  };

  // Open a new turn span for a user prompt / assistant interaction, or return
  // the existing one if we've already seen this interactionId.
  const ensureTurn = (interactionId: string, ts: number, namePreview?: string): TraceSpan => {
    const existing = turnByInteraction.get(interactionId);
    if (existing) {
      if (namePreview && existing.name === "Agent Turn") existing.name = namePreview;
      return existing;
    }
    finalizePrevious();
    const span: TraceSpan = {
      id: turnSpanId(interactionId),
      sessionId,
      type: "turn",
      name: namePreview ?? "Agent Turn",
      startMs: ts,
      status: "running",
      meta: {
        model,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        thinking: undefined as string | undefined,
        interactionId,
      },
    };
    spans.push(span);
    turnByInteraction.set(interactionId, span);
    currentInteractionId = interactionId;
    currentTurnSpanId = span.id;
    return span;
  };

  for (const ev of events) {
    const ts = ev.timestamp ? Date.parse(ev.timestamp) : Date.now();
    const data = ev.data ?? {};

    switch (ev.type) {
      case "session.start":
      case "session.resume": {
        if (typeof data.selectedModel === "string") model = data.selectedModel;
        break;
      }
      case "user.message": {
        const interactionId = typeof data.interactionId === "string" ? data.interactionId : "";
        if (!interactionId) break;
        const content = typeof data.content === "string" ? data.content : "";
        const preview = content.split("\n")[0]?.slice(0, 60).trim();
        ensureTurn(interactionId, ts, preview ? `"${preview}${content.length > (preview?.length ?? 0) ? "…" : ""}"` : undefined);
        break;
      }
      case "assistant.turn_start": {
        const interactionId = typeof data.interactionId === "string" ? data.interactionId : "";
        if (!interactionId) break;
        ensureTurn(interactionId, ts);
        break;
      }
      case "assistant.turn_end": {
        // Inner-turn end — roll the outer turn's endMs forward. Do NOT mark
        // it success yet (more inner turns may follow within the same
        // interaction). Finalization happens when the next interaction
        // starts or the stream ends.
        const span = currentTurnSpanId ? turnByInteraction.get(currentInteractionId ?? "") : undefined;
        if (span) {
          span.endMs = ts;
          span.durationMs = Math.max(0, span.endMs - span.startMs);
        }
        break;
      }
      case "assistant.message": {
        const interactionId = typeof data.interactionId === "string" ? data.interactionId : "";
        const span = interactionId
          ? turnByInteraction.get(interactionId)
          : currentTurnSpanId
          ? turnByInteraction.get(currentInteractionId ?? "")
          : undefined;
        if (!span) break;
        const meta = (span.meta ?? {}) as Record<string, unknown>;
        const tokens = meta.tokens as { input: number; output: number; cacheRead: number; cacheCreation: number } | undefined;
        if (tokens && typeof data.outputTokens === "number") {
          tokens.output += data.outputTokens;
        }
        const reasoning = typeof data.reasoningText === "string" ? data.reasoningText : "";
        if (reasoning) {
          const existing = (meta.thinking as string | undefined) ?? "";
          meta.thinking = existing ? `${existing}\n\n${reasoning}` : reasoning;
        }
        span.meta = meta;
        break;
      }
      case "tool.execution_start": {
        const toolCallId = String(data.toolCallId ?? "");
        const toolName = String(data.toolName ?? "unknown");
        if (!toolCallId) break;
        const span: TraceSpan = {
          id: toolSpanId(toolCallId),
          parentId: currentTurnSpanId ?? undefined,
          sessionId,
          type: "tool",
          name: toolName,
          startMs: ts,
          status: "running",
          meta: { input: data.arguments ?? {}, toolCallId },
        };
        spans.push(span);
        toolById.set(toolCallId, span);
        break;
      }
      case "tool.execution_complete": {
        const toolCallId = String(data.toolCallId ?? "");
        const span = toolById.get(toolCallId);
        if (!span) break;
        span.endMs = ts;
        span.durationMs = Math.max(0, span.endMs - span.startMs);
        const success = !!data.success;
        span.status = success ? "success" : "error";
        const result = data.result;
        const text = extractToolResultText(result);
        if (text) {
          const meta = (span.meta ?? {}) as Record<string, unknown>;
          meta.toolResult = { preview: truncatePreview(text), isError: !success };
          span.meta = meta;
        }
        break;
      }
      default:
        break;
    }
  }

  // End-of-stream: if the current turn has any inner assistant.turn_end
  // (i.e. endMs was set), consider it done; otherwise leave it running.
  if (currentInteractionId) {
    const cur = turnByInteraction.get(currentInteractionId);
    if (cur && cur.status === "running" && cur.endMs !== undefined) {
      cur.status = "success";
    }
  }

  return spans;
}

// ── Watcher ────────────────────────────────────────────────────────────────────

export interface CopilotTranscriptWatcher {
  close(): void;
}

export interface CopilotWatchCallbacks {
  onUpdate: (spans: TraceSpan[]) => void;
  onError?: (err: unknown) => void;
}

export function watchCopilotTranscript(
  copilotSessionId: string,
  sessionId: string,
  cb: CopilotWatchCallbacks
): CopilotTranscriptWatcher {
  const filePath = copilotEventsPath(copilotSessionId);
  const dir = path.dirname(filePath);
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let reader: CopilotEventsReader | null = null;
  let watcher: fs.FSWatcher | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let lastMtime: number | null = null;
  let lastEmit = 0;

  const schedule = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 100);
  };

  const refresh = async () => {
    if (closed) return;
    try {
      if (!reader) {
        const found = await findCopilotEventsFile(copilotSessionId);
        if (!found) return;
        reader = createCopilotEventsReader(found);
      }
      const entries = await reader.readAll();
      const spans = copilotEventsToSpans(entries, { sessionId, copilotSessionId });
      lastEmit = Date.now();
      cb.onUpdate(spans);
    } catch (err) {
      cb.onError?.(err);
    }
  };

  const startWatcher = async () => {
    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, fname) => {
        if (fname && String(fname) !== "events.jsonl") return;
        schedule();
      });
    } catch { /* directory may not exist yet — poll will pick it up */ }

    pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const st = await fsp.stat(filePath);
        if (lastMtime === null) { lastMtime = st.mtimeMs; return; }
        if (st.mtimeMs !== lastMtime) {
          lastMtime = st.mtimeMs;
          if (Date.now() - lastEmit > 500) schedule();
        }
      } catch { /* file not there yet */ }
    }, 1000);
  };

  void refresh().then(startWatcher);

  return {
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
      if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    },
  };
}
