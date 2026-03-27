/**
 * Lightweight in-memory span store for Phase 1 performance tracing.
 *
 * Each agent turn emits a root "turn" span, and each tool call inside that turn
 * emits a child "tool" span linked via parentId. The main process pushes span
 * updates to the renderer via SESSION_TRACE events; the renderer accumulates
 * them in the Zustand session store for display in TracesPanel.
 *
 * No external OTEL stack — fully in-process, zero overhead when the panel is closed.
 */

import { randomUUID } from "crypto";
import type { TraceSpan } from "../src/types/index";

const MAX_SPANS = 500;
const spans: TraceSpan[] = [];

type SpanListener = (span: TraceSpan) => void;
const listeners = new Set<SpanListener>();

/** Subscribe to all span mutations (start + end). Returns an unsubscribe fn. */
export function onSpanUpdate(listener: SpanListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(span: TraceSpan): void {
  for (const listener of listeners) listener({ ...span });
}

/** Start a new span and return its id. */
export function startSpan(
  params: Omit<TraceSpan, "id" | "status" | "endMs" | "durationMs">
): string {
  const id = randomUUID();
  const span: TraceSpan = { ...params, id, status: "running" };
  if (spans.length >= MAX_SPANS) spans.shift();
  spans.push(span);
  notify(span);
  return id;
}

/** Mark a span as finished. No-op if the span is not found. */
export function endSpan(
  id: string,
  status: "success" | "error" = "success",
  meta?: Record<string, unknown>
): void {
  const span = spans.find((s) => s.id === id);
  if (!span) return;
  span.endMs = Date.now();
  span.durationMs = span.endMs - span.startMs;
  span.status = status;
  if (meta) span.meta = { ...span.meta, ...meta };
  notify(span);
}

/** Return shallow copies of all spans, optionally filtered by sessionId. */
export function getSpans(sessionId?: string): TraceSpan[] {
  const result = sessionId
    ? spans.filter((s) => s.sessionId === sessionId)
    : [...spans];
  return result.map((s) => ({ ...s }));
}
