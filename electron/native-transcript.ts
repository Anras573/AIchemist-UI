/**
 * Native-provider JSONL transcript: writer + parser + live watcher.
 *
 * The SDK-backed providers (Claude, Copilot) get the Traces tab "for free"
 * because their SDKs write rich JSONL transcripts that we parse on demand. The
 * self-driven providers (Ollama, OpenAI-compatible) run an in-process tool loop
 * and persist nothing trace-shaped, so their Traces tab was empty.
 *
 * This module closes that gap. Each turn, the provider creates a
 * `NativeTranscriptRecorder` that appends structured events to
 *   ~/.aichemist/traces/<sessionId>/events.jsonl
 * and `nativeEventsToSpans()` turns those events into the same `TraceSpan[]`
 * shape the Claude/Copilot parsers produce.
 *
 * Design mirrors claude-transcript.ts:
 *   • Canonical span ids — turn spans keyed by a per-turn uuid, tool spans by
 *     the tool_call id. Deterministic across reparses.
 *   • Append-only writer — one JSON line per event. Tool call/result events are
 *     written as they happen so live spans appear mid-turn; turn-level summary
 *     (usage, reasoning) is folded into a single event at turn end to avoid
 *     write amplification on streaming providers.
 *   • Fail-safe — every write is wrapped so a transcript I/O error can never
 *     break the agent turn.
 */

import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import type { TraceSpan } from "../src/types/index";

// ── Paths ───────────────────────────────────────────────────────────────────────

let tracesRootOverride: string | null = null;

/** Test seam — redirect the traces root away from the real home dir. */
export function _setNativeTracesRootForTests(dir: string | null): void {
  tracesRootOverride = dir;
}

/** `~/.aichemist/traces` root (one subdirectory per session). */
export function nativeTracesRoot(): string {
  return tracesRootOverride ?? path.join(os.homedir(), ".aichemist", "traces");
}

/** Absolute path of a session's native transcript file. */
export function nativeTranscriptPath(sessionId: string): string {
  return path.join(nativeTracesRoot(), sessionId, "events.jsonl");
}

/** Returns the transcript path if it exists on disk, else null. */
export function findNativeTranscriptFile(sessionId: string): string | null {
  const file = nativeTranscriptPath(sessionId);
  try {
    return fs.existsSync(file) ? file : null;
  } catch {
    return null;
  }
}

// ── Event model ─────────────────────────────────────────────────────────────────

interface NativeEventBase {
  ts: number;
  turnId: string;
}

export type NativeEvent =
  | (NativeEventBase & { type: "turn_start"; provider: string; model?: string })
  | (NativeEventBase & { type: "tool_call"; toolCallId: string; name: string; input: unknown })
  | (NativeEventBase & { type: "tool_result"; toolCallId: string; isError: boolean; output: string })
  | (NativeEventBase & { type: "reasoning"; text: string })
  | (NativeEventBase & {
      type: "usage";
      input: number;
      output: number;
      cacheRead: number;
      cacheCreation: number;
    })
  | (NativeEventBase & { type: "turn_end"; status: "success" | "error" });

// ── Writer ──────────────────────────────────────────────────────────────────────

export interface NativeTranscriptRecorder {
  /** Open the turn — written first so the file (and live turn span) exists. */
  turnStart(model?: string): void;
  /** Accumulate streamed reasoning/thinking text (flushed once at turn end). */
  reasoning(text: string): void;
  /** A tool call has started — written immediately for a live tool span. */
  toolCall(toolCallId: string, name: string, input: unknown): void;
  /** A tool call produced output — written immediately to close the span. */
  toolResult(toolCallId: string, output: string, isError: boolean): void;
  /** Latest token usage for the turn (folded into the turn-end summary). */
  usage(u: { input: number; output: number; cacheRead: number; cacheCreation: number }): void;
  /** Finalize the turn (idempotent) — flushes reasoning + usage, then turn_end. */
  turnEnd(status: "success" | "error"): void;
}

/**
 * Create a per-turn recorder. One instance owns exactly one turn (one
 * `provider.run()` call); the turn id is generated up front so every event
 * carries it.
 */
export function createNativeTranscriptRecorder(
  sessionId: string,
  provider: string,
): NativeTranscriptRecorder {
  const file = nativeTranscriptPath(sessionId);
  const turnId = crypto.randomUUID();
  let reasoningBuf = "";
  let lastUsage: { input: number; output: number; cacheRead: number; cacheCreation: number } | null =
    null;
  let ended = false;

  const append = (event: NativeEvent): void => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, JSON.stringify(event) + "\n");
    } catch {
      /* transcript writes must never break a turn */
    }
  };

  return {
    turnStart(model) {
      append({ type: "turn_start", ts: Date.now(), turnId, provider, model });
    },
    reasoning(text) {
      if (text) reasoningBuf += text;
    },
    toolCall(toolCallId, name, input) {
      append({ type: "tool_call", ts: Date.now(), turnId, toolCallId, name, input });
    },
    toolResult(toolCallId, output, isError) {
      append({ type: "tool_result", ts: Date.now(), turnId, toolCallId, isError, output });
    },
    usage(u) {
      lastUsage = u;
    },
    turnEnd(status) {
      if (ended) return;
      ended = true;
      if (reasoningBuf) {
        append({ type: "reasoning", ts: Date.now(), turnId, text: reasoningBuf });
      }
      if (lastUsage) {
        append({ type: "usage", ts: Date.now(), turnId, ...lastUsage });
      }
      append({ type: "turn_end", ts: Date.now(), turnId, status });
    },
  };
}

// ── Parsing ─────────────────────────────────────────────────────────────────────

/** One-shot parse for tests / GET_TRACES — skips malformed lines. */
export async function parseNativeTranscript(filePath: string): Promise<NativeEvent[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch {
    return [];
  }
  const out: NativeEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as NativeEvent);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

function truncatePreview(s: string, lines = 5, maxLen = 800): string {
  const split = s.split("\n");
  const head = split.slice(0, lines).join("\n");
  const omitted = split.length - lines;
  const trimmed = head.length > maxLen ? head.slice(0, maxLen) + "…" : head;
  return omitted > 0 ? `${trimmed}\n… (+${omitted} more lines)` : trimmed;
}

export interface NativeSpanOptions {
  sessionId: string; // app session id (owns the spans)
}

interface TurnAccum {
  turnId: string;
  startMs: number;
  endMs: number;
  status: "running" | "success" | "error";
  model?: string;
  reasoning: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheCreation: number };
  tools: Map<string, { name: string; input: unknown; startMs: number }>;
  toolOrder: string[];
  results: Map<string, { output: string; isError: boolean; endMs: number }>;
}

/**
 * Build TraceSpans from native transcript events.
 *
 * Each `turn_start` opens a turn span (running until its `turn_end`); tool_call
 * / tool_result pairs (matched by tool_call id) become tool spans parented to
 * their turn. Turns are emitted in start order.
 */
export function nativeEventsToSpans(events: NativeEvent[], opts: NativeSpanOptions): TraceSpan[] {
  const { sessionId } = opts;
  const turns = new Map<string, TurnAccum>();
  const order: string[] = [];

  const ensureTurn = (turnId: string, ts: number): TurnAccum => {
    let t = turns.get(turnId);
    if (!t) {
      t = {
        turnId,
        startMs: ts,
        endMs: ts,
        status: "running",
        reasoning: "",
        tools: new Map(),
        toolOrder: [],
        results: new Map(),
      };
      turns.set(turnId, t);
      order.push(turnId);
    }
    return t;
  };

  for (const e of events) {
    const t = ensureTurn(e.turnId, e.ts);
    if (e.ts > t.endMs) t.endMs = e.ts;
    switch (e.type) {
      case "turn_start":
        t.startMs = e.ts;
        t.model = e.model;
        break;
      case "tool_call":
        if (!t.tools.has(e.toolCallId)) t.toolOrder.push(e.toolCallId);
        t.tools.set(e.toolCallId, { name: e.name, input: e.input, startMs: e.ts });
        break;
      case "tool_result":
        t.results.set(e.toolCallId, { output: e.output, isError: e.isError, endMs: e.ts });
        break;
      case "reasoning":
        t.reasoning += (t.reasoning ? "\n\n" : "") + e.text;
        break;
      case "usage":
        t.tokens = {
          input: e.input,
          output: e.output,
          cacheRead: e.cacheRead,
          cacheCreation: e.cacheCreation,
        };
        break;
      case "turn_end":
        t.status = e.status;
        t.endMs = e.ts;
        break;
    }
  }

  const spans: TraceSpan[] = [];
  for (const turnId of order) {
    const t = turns.get(turnId)!;
    const turnSpanId = `turn:native:${sessionId}:${turnId}`;
    spans.push({
      id: turnSpanId,
      sessionId,
      type: "turn",
      name: "Agent Turn",
      startMs: t.startMs,
      endMs: t.status === "running" ? undefined : t.endMs,
      durationMs: t.status === "running" ? undefined : Math.max(0, t.endMs - t.startMs),
      status: t.status,
      meta: {
        model: t.model,
        tokens: t.tokens,
        thinking: t.reasoning || undefined,
      },
    });

    for (const toolCallId of t.toolOrder) {
      const call = t.tools.get(toolCallId)!;
      const res = t.results.get(toolCallId);
      spans.push({
        id: `tool:${toolCallId}`,
        parentId: turnSpanId,
        sessionId,
        type: "tool",
        name: call.name,
        startMs: call.startMs,
        endMs: res?.endMs,
        durationMs: res ? Math.max(0, res.endMs - call.startMs) : undefined,
        status: res ? (res.isError ? "error" : "success") : "running",
        meta: {
          input: call.input,
          toolCallId,
          toolResult: res ? { preview: truncatePreview(res.output), isError: res.isError } : undefined,
        },
      });
    }
  }

  return spans;
}

// ── Watcher ─────────────────────────────────────────────────────────────────────

export interface NativeTranscriptWatcher {
  close(): void;
}

export interface NativeWatchCallbacks {
  onUpdate: (spans: TraceSpan[]) => void;
  onError?: (err: unknown) => void;
}

/**
 * Watch a session's native transcript and emit the full enriched span list on
 * every change (debounced 100ms). Watches the session directory so the file
 * appearing mid-turn (first turn) is still picked up.
 */
export function watchNativeTranscript(
  sessionId: string,
  cb: NativeWatchCallbacks,
): NativeTranscriptWatcher {
  const file = nativeTranscriptPath(sessionId);
  const dir = path.dirname(file);
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  const refresh = async () => {
    if (closed) return;
    try {
      const events = await parseNativeTranscript(file);
      cb.onUpdate(nativeEventsToSpans(events, { sessionId }));
    } catch (err) {
      cb.onError?.(err);
    }
  };

  const schedule = () => {
    if (closed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, 100);
  };

  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, { persistent: false }, (_event, fname) => {
      if (fname && String(fname) !== "events.jsonl") return;
      schedule();
    });
  } catch {
    /* best effort */
  }

  // Initial emit for whatever already exists on disk.
  void refresh();

  return {
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher) {
        try {
          watcher.close();
        } catch {
          /* ignore */
        }
      }
    },
  };
}
