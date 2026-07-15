/**
 * One-time (idempotent, re-runnable) backfill of the usage ledger (#156) from
 * pre-existing trace transcripts, so sessions that predate the ledger don't
 * show as zero spend forever in the Spending panel (issue #160, epic #155).
 *
 * Idempotency + scope: a session is only backfilled when it has ZERO
 * usage_ledger rows at all. Once backfilled (or once it's recorded any live
 * usage via the normal turn path), it's left alone on every later run —
 * re-running is then a no-op for it. This deliberately does NOT top up
 * sessions that already have live rows (used both before and after the
 * ledger shipped): filling in only the pre-ledger gap for those would need
 * per-turn de-duplication against the transcript, which epic #155 explicitly
 * scopes out (its non-goals rule out retroactive correction of historical
 * turns). Those sessions' pre-ledger turns remain unrecovered — a documented
 * gap, not a bug (see docs/spending.md).
 *
 * Safe to run on every app start: already-backfilled / already-live sessions
 * are skipped by a single indexed lookup, and a transcript that can't be
 * read/parsed just yields zero turns rather than throwing (the underlying
 * parsers in claude-transcript.ts / copilot-transcript.ts / native-transcript.ts
 * are themselves fail-safe). The per-session try/catch below is an extra
 * safety net so a genuinely unexpected error (e.g. a DB write failure) can
 * never abort the run for the remaining sessions.
 */

import type { Database } from "better-sqlite3";
import type { Provider, SessionUsage, TraceSpan } from "../src/types/index";
import { recordUsage } from "./usage-ledger";
import { resolveTraceSource, loadTranscriptSpans } from "./trace-source";

export interface BackfillSessionResult {
  sessionId: string;
  status: "backfilled" | "skipped-has-usage" | "skipped-no-transcript" | "error";
  turnsBackfilled: number;
  error?: string;
}

export interface BackfillResult {
  sessions: BackfillSessionResult[];
  totalTurnsBackfilled: number;
}

function extractTokens(span: TraceSpan): SessionUsage {
  const tokens = span.meta?.["tokens"] as
    | { input?: number; output?: number; cacheRead?: number; cacheCreation?: number }
    | undefined;
  return {
    input_tokens: tokens?.input ?? 0,
    output_tokens: tokens?.output ?? 0,
    cache_read_input_tokens: tokens?.cacheRead ?? 0,
    cache_creation_input_tokens: tokens?.cacheCreation ?? 0,
  };
}

function extractModel(span: TraceSpan): string | null {
  const model = span.meta?.["model"];
  return typeof model === "string" && model.trim() ? model : null;
}

/** Completed (non-running) turn spans — a still-running turn has no final usage to backfill yet. */
function isCompletedTurn(span: TraceSpan): boolean {
  return span.type === "turn" && span.status !== "running";
}

/**
 * Backfill the usage ledger from historical transcripts for every session (or
 * just `opts.projectId`'s sessions) that has no usage_ledger rows yet.
 * Fail-safe per session: any error resolving/parsing one session's transcript
 * is caught, logged, and recorded as an `"error"` result rather than aborting
 * the run for the rest.
 */
export async function backfillUsageLedger(
  db: Database,
  opts: { projectId?: string } = {}
): Promise<BackfillResult> {
  const sessions = (
    opts.projectId
      ? db.prepare("SELECT id, project_id FROM sessions WHERE project_id = ?").all(opts.projectId)
      : db.prepare("SELECT id, project_id FROM sessions").all()
  ) as Array<{ id: string; project_id: string }>;

  const results: BackfillSessionResult[] = [];
  let totalTurnsBackfilled = 0;

  for (const session of sessions) {
    try {
      const hasUsage = db
        .prepare("SELECT 1 FROM usage_ledger WHERE session_id = ? LIMIT 1")
        .get(session.id);
      if (hasUsage) {
        results.push({ sessionId: session.id, status: "skipped-has-usage", turnsBackfilled: 0 });
        continue;
      }

      const src = resolveTraceSource(db, session.id);
      if (!src) {
        results.push({ sessionId: session.id, status: "skipped-no-transcript", turnsBackfilled: 0 });
        continue;
      }

      const spans = await loadTranscriptSpans(db, session.id);
      const turns = spans.filter(isCompletedTurn);
      if (turns.length === 0) {
        results.push({ sessionId: session.id, status: "skipped-no-transcript", turnsBackfilled: 0 });
        continue;
      }

      // Atomic per session: if any recordUsage() call in this loop throws, the
      // transaction rolls back to zero rows for this session rather than
      // leaving it partially backfilled. A partial session would otherwise be
      // permanently stuck — the next run's hasUsage check above would see the
      // surviving rows and skip it forever instead of retrying.
      const insertTurns = db.transaction(() => {
        for (const turn of turns) {
          recordUsage(db, {
            sessionId: session.id,
            projectId: session.project_id,
            provider: src.provider as Provider,
            model: extractModel(turn),
            usage: extractTokens(turn),
            createdAt: new Date(turn.endMs ?? turn.startMs).toISOString(),
            source: "backfill",
          });
        }
      });
      insertTurns();
      totalTurnsBackfilled += turns.length;
      results.push({ sessionId: session.id, status: "backfilled", turnsBackfilled: turns.length });
    } catch (err) {
      console.error(`[usage-backfill] Failed to backfill session ${session.id}:`, err);
      results.push({
        sessionId: session.id,
        status: "error",
        turnsBackfilled: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { sessions: results, totalTurnsBackfilled };
}
