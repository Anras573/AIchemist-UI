import { Cron } from "croner";

// Lightweight, dependency-free cron validation shared by the IPC validators and
// the workflow scheduler. Kept in its own module (rather than in
// `workflow-scheduler.ts`) so `electron/ipc/validators.ts` — imported for every
// IPC handler registration — doesn't pull in the scheduler's heavy dependency
// graph (turn queue, runner, providers, GitHub helpers).
//
// `croner` parses the expression eagerly in its constructor and throws on an
// unparseable pattern. We construct with `{ paused: true }` so validating never
// arms a real timer — we only care whether parsing succeeds.

/**
 * Validate a cron expression via `croner`. Returns the trimmed expression on
 * success; throws an `Error` with a descriptive message on failure. Used at
 * `WORKFLOW_UPSERT` so an unparseable schedule is rejected before it is stored.
 */
export function validateCron(expr: string): string {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error("Cron expression is empty");
  try {
    // Constructing parses + validates; paused so no job is armed here.
    new Cron(trimmed, { paused: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid cron expression "${expr}": ${detail}`);
  }
  return trimmed;
}

/** Non-throwing companion to {@link validateCron}. */
export function isValidCron(expr: string): boolean {
  try {
    validateCron(expr);
    return true;
  } catch {
    return false;
  }
}
