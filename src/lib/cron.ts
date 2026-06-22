import { Cron } from "croner";

/**
 * Renderer-side cron helpers for the Workflows editor. `croner` is a
 * zero-dependency, browser-safe library, so we can parse the expression and
 * compute the next occurrence directly in the renderer for a live preview —
 * no IPC round-trip needed. This mirrors the validation the main process does
 * at `WORKFLOW_UPSERT` (`electron/cron.ts`), but adds a human-readable preview.
 */

export interface CronPreview {
  /** Whether the expression parsed successfully. */
  valid: boolean;
  /** The next scheduled occurrence, or null if invalid / never fires. */
  next: Date | null;
  /** A short human-readable description of the next run, or an error message. */
  label: string;
}

/** A blank expression means "manual-only" — not an error, just no schedule. */
export function previewCron(expr: string): CronPreview {
  const trimmed = expr.trim();
  if (!trimmed) {
    return { valid: true, next: null, label: "Manual only — no schedule" };
  }
  try {
    // `{ paused: true }` parses + validates without arming a real timer.
    const cron = new Cron(trimmed, { paused: true });
    const next = cron.nextRun();
    if (!next) {
      return { valid: true, next: null, label: "Valid, but has no upcoming runs" };
    }
    return { valid: true, next, label: `Next run ${formatRelative(next)}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { valid: false, next: null, label: `Invalid: ${detail}` };
  }
}

/** Format an absolute date plus a coarse relative hint ("in 5 minutes"). */
export function formatRelative(date: Date, now: Date = new Date()): string {
  const absolute = date.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const diffMs = date.getTime() - now.getTime();
  if (diffMs <= 0) return absolute;

  const mins = Math.round(diffMs / 60_000);
  let rel: string;
  if (mins < 1) rel = "in less than a minute";
  else if (mins < 60) rel = `in ${mins} minute${mins === 1 ? "" : "s"}`;
  else if (mins < 60 * 24) {
    const hrs = Math.round(mins / 60);
    rel = `in ${hrs} hour${hrs === 1 ? "" : "s"}`;
  } else {
    const days = Math.round(mins / (60 * 24));
    rel = `in ${days} day${days === 1 ? "" : "s"}`;
  }
  return `${absolute} (${rel})`;
}
