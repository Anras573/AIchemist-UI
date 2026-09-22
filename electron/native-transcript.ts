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

export interface NativeTranscriptReader {
  /** Re-read any new bytes since the last call; returns the full events list. */
  readAll(): Promise<NativeEvent[]>;
  /** Re-read only new events since the last call. */
  readIncremental(): Promise<{ newEntries: NativeEvent[]; didReset: boolean }>;
  /** Reset offset + buffer (force a full re-parse next call). */
  reset(): void;
}

/**
 * Incremental reader — keeps a byte offset + partial-line buffer so a live
 * watcher only parses appended bytes instead of re-reading the whole file on
 * every change. Mirrors `createTranscriptReader` in claude-transcript.ts.
 */
export function createNativeTranscriptReader(filePath: string): NativeTranscriptReader {
  let offset = 0;
  let buffer = "";
  const events: NativeEvent[] = [];

  async function pull(): Promise<{ newEntries: NativeEvent[]; didReset: boolean }> {
    let didReset = false;
    let size = 0;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch {
      return { newEntries: [], didReset: false };
    }
    if (size < offset) {
      // File was truncated / rotated — start over (append-only in practice).
      offset = 0;
      buffer = "";
      events.length = 0;
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
    // Last element is the (possibly empty) trailing partial — keep it for next call.
    buffer = lines.pop() ?? "";
    const newOnes: NativeEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        newOnes.push(JSON.parse(line) as NativeEvent);
      } catch {
        /* skip malformed line */
      }
    }
    events.push(...newOnes);
    return { newEntries: newOnes, didReset };
  }

  return {
    async readAll() {
      await pull();
      return [...events];
    },
    async readIncremental() {
      return pull();
    },
    reset() {
      offset = 0;
      buffer = "";
      events.length = 0;
    },
  };
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

export interface NativeSpanAccumulator {
  /**
   * Fold newly-read events into the running turn/tool state and return the
   * full, up-to-date span list. Only `newEvents` are walked — spans for turns
   * untouched by this batch are reused as-is rather than rebuilt, which is
   * what keeps a long-lived session's live-watcher refresh cost bounded by
   * the size of each update instead of the whole transcript (issue #207).
   */
  applyEvents(newEvents: NativeEvent[]): TraceSpan[];
}

/**
 * Stateful, incremental span builder for native transcript events. Create one
 * per watched session and keep feeding it newly-read events (not the full
 * cumulative list) on each refresh.
 */
export function createNativeSpanAccumulator(opts: NativeSpanOptions): NativeSpanAccumulator {
  const { sessionId } = opts;
  const turns = new Map<string, TurnAccum>();
  const order: string[] = [];
  const spanById = new Map<string, TraceSpan>();

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

  const turnSpanId = (turnId: string) => `turn:native:${sessionId}:${turnId}`;

  const rebuildTurnSpans = (t: TurnAccum): void => {
    const tsId = turnSpanId(t.turnId);
    spanById.set(tsId, {
      id: tsId,
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
      spanById.set(`tool:${toolCallId}`, {
        id: `tool:${toolCallId}`,
        parentId: tsId,
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
  };

  return {
    applyEvents(newEvents) {
      const dirty = new Set<string>();
      for (const e of newEvents) {
        const t = ensureTurn(e.turnId, e.ts);
        dirty.add(e.turnId);
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

      for (const turnId of dirty) {
        rebuildTurnSpans(turns.get(turnId)!);
      }

      const spans: TraceSpan[] = [];
      for (const turnId of order) {
        const t = turns.get(turnId)!;
        spans.push(spanById.get(turnSpanId(turnId))!);
        for (const toolCallId of t.toolOrder) {
          spans.push(spanById.get(`tool:${toolCallId}`)!);
        }
      }
      return spans;
    },
  };
}

/**
 * Build TraceSpans from native transcript events.
 *
 * Each `turn_start` opens a turn span (running until its `turn_end`); tool_call
 * / tool_result pairs (matched by tool_call id) become tool spans parented to
 * their turn. Turns are emitted in start order.
 *
 * One-shot wrapper over `createNativeSpanAccumulator` for callers (tests,
 * `GET_TRACES`, usage-ledger backfill) that just want a full parse and don't
 * need to keep state between calls.
 */
export function nativeEventsToSpans(events: NativeEvent[], opts: NativeSpanOptions): TraceSpan[] {
  return createNativeSpanAccumulator(opts).applyEvents(events);
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
  const reader = createNativeTranscriptReader(file);
  let accumulator = createNativeSpanAccumulator({ sessionId });
  let closed = false;
  let debounceTimer: NodeJS.Timeout | null = null;
  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let lastEmit = 0;
  let lastMtime: number | null = null;

  const refresh = async () => {
    if (closed) return;
    try {
      // Incremental read — only appended bytes are parsed per change, and
      // only the new events (not the whole cumulative history) are folded
      // into the span accumulator (issue #207).
      const { newEntries, didReset } = await reader.readIncremental();
      if (didReset) accumulator = createNativeSpanAccumulator({ sessionId });
      if (newEntries.length === 0 && !didReset) return;
      const spans = accumulator.applyEvents(newEntries);
      lastEmit = Date.now();
      cb.onUpdate(spans);
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

  // macOS fs.watch safety-net: stat-poll the file every 1s and schedule a
  // refresh when mtime changed without a recent fs.watch-driven emit. Mirrors
  // the fallback in claude-transcript.ts so updates aren't silently missed.
  pollTimer = setInterval(async () => {
    if (closed) return;
    try {
      const st = await fsp.stat(file);
      if (lastMtime === null) {
        lastMtime = st.mtimeMs;
        // File just appeared — emit now in case fs.watch missed the create
        // event, so the initial turn_start renders without waiting for the
        // next write. The initial void refresh() may have run before the file
        // existed; the lastEmit guard avoids a redundant double-emit.
        if (Date.now() - lastEmit > 500) schedule();
        return;
      }
      if (st.mtimeMs !== lastMtime) {
        lastMtime = st.mtimeMs;
        if (Date.now() - lastEmit > 500) schedule();
      }
    } catch {
      /* file may not exist yet */
    }
  }, 1000);

  // Initial emit for whatever already exists on disk.
  void refresh();

  return {
    close() {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      if (pollTimer) clearInterval(pollTimer);
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
