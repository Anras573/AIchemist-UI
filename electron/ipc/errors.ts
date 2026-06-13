/**
 * Structured IPC errors and the request/response envelope.
 *
 * This module is intentionally dependency-free so it can be imported from both
 * the main process (`handle.ts`) and the preload/renderer (`preload.ts`,
 * `src/lib/ipc.ts`) without pulling in Electron or Node APIs.
 *
 * Every `ipcMain.handle()` registered through `handle()` resolves to an
 * `IpcEnvelope`: either `{ ok: true, data }` or `{ ok: false, error }`. The
 * preload bridge unwraps it via `unwrap()` so the renderer keeps its existing
 * "resolve the value / throw on failure" ergonomics — but the thrown error now
 * carries a machine-readable `code` the UI can branch on.
 */

/** Machine-readable error categories the renderer can branch on. */
export type IpcErrorCode =
  | "internal" // unclassified / unexpected failure
  | "invalid_input" // request failed validation (zod) or argument checks
  | "not_found" // a referenced project/session/resource does not exist
  | "conflict" // the operation collides with current state (e.g. session busy)
  | "unauthorized" // missing/invalid credentials
  | "timeout" // the operation timed out
  | "unavailable"; // a dependency (provider, key, window) is not available

/** Error carrying an {@link IpcErrorCode}. Throw this from a handler to set the code explicitly. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  constructor(code: IpcErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
    this.code = code;
  }
}

export interface IpcSuccess<T> {
  ok: true;
  data: T;
}
export interface IpcFailure {
  ok: false;
  error: { code: IpcErrorCode; message: string };
}
export type IpcEnvelope<T> = IpcSuccess<T> | IpcFailure;

/**
 * Maps an arbitrary thrown value to a `{ code, message }` pair. An {@link IpcError}
 * keeps its explicit code; otherwise we apply conservative heuristics over the
 * message so the common cases (missing resource, busy session, bad input) get a
 * useful category without every throw site having to be rewritten. The message
 * is always preserved verbatim.
 */
export function classifyError(err: unknown): { code: IpcErrorCode; message: string } {
  if (err instanceof IpcError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: inferCode(message), message };
}

function inferCode(message: string): IpcErrorCode {
  const m = message.toLowerCase();
  if (/\bnot found\b|does not exist|no such/.test(m)) return "not_found";
  if (/\bbusy\b|already (running|in progress)|conflict/.test(m)) return "conflict";
  if (/timed? ?out|timeout/.test(m)) return "timeout";
  if (/unauthor|forbidden|invalid (api )?key|authentication|not configured/.test(m)) return "unauthorized";
  if (/no window|unavailable|no models|not available|not running/.test(m)) return "unavailable";
  if (/invalid|must be|cannot |refusing|outside the library|only github|escapes/.test(m))
    return "invalid_input";
  return "internal";
}

/**
 * Unwraps an {@link IpcEnvelope} produced by `handle()`. Returns `data` on
 * success; throws an {@link IpcError} (carrying the structured `code`) on
 * failure. A bare (non-enveloped) value is passed through unchanged for
 * defensiveness against any handler that bypasses `handle()`.
 */
export function unwrap<T>(value: IpcEnvelope<T> | T): T {
  if (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    ("data" in value || "error" in value)
  ) {
    const env = value as IpcEnvelope<T>;
    if (env.ok) return env.data;
    throw new IpcError(env.error.code, env.error.message);
  }
  return value as T;
}
