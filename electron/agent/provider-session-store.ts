import type { Database } from "better-sqlite3";

/**
 * Unified, provider-agnostic session state.
 *
 * Each provider owns one slice of the blob stored in `sessions.provider_state`
 * (a single JSON column). Adding a new provider means adding a key here — no new
 * schema migration. The DB is the source of truth; {@link ProviderSessionStore}
 * keeps an in-memory read-through cache for the fast path within one app run.
 */

/** Claude (Anthropic) per-session SDK state. */
export interface ClaudeSessionState {
  /** Anthropic SDK session id — enables `resume:` across turns and restarts. */
  sdkSessionId?: string | null;
}

/** Copilot (GitHub) per-session SDK state. */
export interface CopilotSessionState {
  /** Copilot SDK session id — enables `resumeSession()` across turns/restarts. */
  sessionId?: string | null;
  /**
   * Agent active when the SDK session was created. Used to detect agent changes
   * across turns/restarts and force a fresh session (resumeSession does not
   * update the system message of an existing session).
   */
  agent?: string | null;
  /**
   * Fingerprint of the AIchemist-managed MCP server map active when the SDK
   * session was created. A change forces a fresh session (resumeSession ignores
   * an updated mcpServers map).
   */
  mcpFp?: string | null;
}

export interface ProviderSessionState {
  claude?: ClaudeSessionState;
  copilot?: CopilotSessionState;
}

export type ProviderKey = keyof ProviderSessionState;

/** Keys that could pollute Object.prototype if copied via spread/assign. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Defensive parse of the raw `provider_state` JSON column. Returns an empty
 * object for null/empty/malformed input so a corrupted row never throws. A
 * reviver strips `__proto__` / `constructor` / `prototype` at every depth so a
 * corrupted or hostile DB row can't trigger prototype pollution when the parsed
 * object is later spread.
 */
export function parseProviderSessionState(
  raw: string | null | undefined
): ProviderSessionState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw, (key, value) =>
      DANGEROUS_KEYS.has(key) ? undefined : value
    );
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ProviderSessionState;
    }
  } catch {
    /* fall through to empty */
  }
  return {};
}

/** Serialize provider state, collapsing the empty blob to NULL. */
function serializeProviderSessionState(state: ProviderSessionState): string | null {
  return Object.keys(state).length === 0 ? null : JSON.stringify(state);
}

/**
 * Read-through cache over `sessions.provider_state`. The DB is authoritative;
 * the in-memory map is a per-app-run fast path that is repopulated from the DB
 * on first access. Because every read and write goes through the same DB-backed
 * blob, there is no "seeded from DB" gate and no in-memory/DB normalization
 * footgun (the old Copilot `copilotSessionIds` / `seededFromDb` pair).
 *
 * Returned objects are snapshots — callers must treat them as read-only and use
 * {@link set} to persist changes.
 */
class ProviderSessionStore {
  private readonly cache = new Map<string, ProviderSessionState>();

  /** Load the full blob for a session (read-through). */
  private read(db: Database, sessionId: string): ProviderSessionState {
    const cached = this.cache.get(sessionId);
    if (cached) return cached;
    const row = db
      .prepare("SELECT provider_state FROM sessions WHERE id = ?")
      .get(sessionId) as { provider_state: string | null } | undefined;
    const state = parseProviderSessionState(row?.provider_state);
    this.cache.set(sessionId, state);
    return state;
  }

  /** Get one provider's slice of state (or undefined if never persisted). */
  get<K extends ProviderKey>(
    db: Database,
    sessionId: string,
    provider: K
  ): ProviderSessionState[K] {
    const slice = this.read(db, sessionId)[provider];
    // Treat a corrupted, non-object slice (e.g. `{"claude":null}` or
    // `{"claude":"x"}` in a hand-edited row) as absent. Otherwise return a
    // shallow copy so a caller mutating the result can't silently diverge the
    // cache from the DB (slices are flat objects).
    if (!slice || typeof slice !== "object" || Array.isArray(slice)) {
      return undefined;
    }
    return { ...slice } as ProviderSessionState[K];
  }

  /**
   * Write one provider's slice (write-through to DB + cache). Pass `null` to
   * remove the slice (e.g. invalidating a stale SDK session).
   */
  set<K extends ProviderKey>(
    db: Database,
    sessionId: string,
    provider: K,
    state: NonNullable<ProviderSessionState[K]> | null
  ): void {
    const next: ProviderSessionState = { ...this.read(db, sessionId) };
    if (state === null) {
      delete next[provider];
    } else {
      // Clone the incoming slice so a later mutation by the caller can't reach
      // into the cache.
      next[provider] = { ...state } as NonNullable<ProviderSessionState[K]>;
    }
    // Write through to the DB FIRST, then update the cache only if the row still
    // exists. This way a throwing UPDATE never leaves the cache ahead of the DB,
    // and a concurrently-deleted session (changes === 0) doesn't re-introduce
    // phantom cache state.
    const info = db
      .prepare("UPDATE sessions SET provider_state = ? WHERE id = ?")
      .run(serializeProviderSessionState(next), sessionId);
    if (info.changes > 0) {
      this.cache.set(sessionId, next);
    } else {
      this.cache.delete(sessionId);
    }
  }

  /**
   * Drop the in-memory cache entry for a session (the DB row is expected to be
   * deleted by the caller, e.g. via cascade on session delete).
   */
  forget(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  /**
   * Clear the entire in-memory cache. The DB is untouched, so subsequent reads
   * repopulate from it. Primary use is the test seam; also used when the Copilot
   * client is stopped so stale in-memory SDK ids don't linger.
   */
  reset(): void {
    this.cache.clear();
  }
}

/** App-wide singleton. */
export const providerSessionStore = new ProviderSessionStore();

/** Test seam — drop the in-memory cache between tests. */
export function _resetProviderSessionStore(): void {
  providerSessionStore.reset();
}
