import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * A tiny SWR-style data-fetching hook for IPC reads.
 *
 * Goals (see issue #57):
 *  - **TTL caching** — a value fetched for a `key` is reused for `ttl` ms, so
 *    panels that mount/unmount (or several components reading the same key) don't
 *    each fire their own IPC round-trip. This is what de-duplicates the two
 *    independent `getGitBranch()` fetches in `InputBar` and `OpenPrSection`.
 *  - **In-flight dedupe** — concurrent subscribers to the same key share a single
 *    pending promise rather than racing N identical calls.
 *
 * It is intentionally *not* React Query: no mutation cache, no window-focus
 * revalidation, no garbage collection. The cache lives for the lifetime of the
 * renderer process (entries are never evicted, only overwritten on refetch),
 * which is fine for the handful of small reads the right-side panels do.
 *
 * The `fetcher` receives `{ force }` so a caller can serve a different request on
 * an explicit refresh than on the cached initial load (e.g. the MCP panel hits
 * the cheap list endpoint on mount but re-probes every server on refresh).
 */

const DEFAULT_TTL_MS = 30_000;

type FetchOptions = { force: boolean };
type Fetcher<T> = (opts: FetchOptions) => Promise<T>;
type Status = "loading" | "success" | "error";

interface CacheEntry<T> {
  status: Status;
  data?: T;
  error?: unknown;
  /** Epoch ms of the last settle (success or error). `0` means never settled. */
  settledAt: number;
  /** The in-flight fetch promise, if one is running — used for dedupe. */
  promise?: Promise<void>;
  /** Subscribed hook instances to notify on every state transition. */
  listeners: Set<() => void>;
}

// Module-level cache shared across every `useIpcQuery` caller. Keyed by the
// caller-supplied string, which must encode all inputs the fetcher depends on.
const cache = new Map<string, CacheEntry<unknown>>();

function getEntry<T>(key: string): CacheEntry<T> {
  let entry = cache.get(key) as CacheEntry<T> | undefined;
  if (!entry) {
    entry = { status: "loading", settledAt: 0, listeners: new Set() };
    cache.set(key, entry as CacheEntry<unknown>);
  }
  return entry;
}

function notify(entry: CacheEntry<unknown>): void {
  entry.listeners.forEach((listener) => listener());
}

function runFetch<T>(key: string, fetcher: Fetcher<T>, force: boolean): Promise<void> {
  const entry = getEntry<T>(key);

  // In-flight dedupe: a second caller joins the running fetch instead of
  // starting its own. `force` can't preempt a fetch already on the wire.
  if (entry.promise) return entry.promise;

  // Keep the last *successful* value visible while revalidating; but when there
  // is no cached data (initial load, or the previous attempt errored) flip to
  // the loading state. Either way, clear any stale error up front so a Retry /
  // refetch doesn't keep rendering the old error while the new request is in
  // flight — `error` is re-set only if this fetch itself fails.
  const hasData = entry.data !== undefined;
  entry.status = hasData ? "success" : "loading";
  entry.error = undefined;

  const promise = (async () => {
    try {
      const data = await fetcher({ force });
      entry.data = data;
      entry.error = undefined;
      entry.status = "success";
    } catch (err) {
      entry.error = err;
      entry.status = "error";
    } finally {
      entry.settledAt = Date.now();
      entry.promise = undefined;
      notify(entry);
    }
  })();

  entry.promise = promise;
  // Notify at the start too so subscribers can render the loading/revalidating
  // state immediately rather than only once the fetch settles.
  notify(entry);
  return promise;
}

export interface UseIpcQueryResult<T> {
  /** The cached value, or `undefined` until the first successful fetch. */
  data: T | undefined;
  /** The error from the last failed fetch, or `undefined`. */
  error: unknown;
  /** `true` while there is no data yet and a fetch is pending (initial load). */
  loading: boolean;
  /** `true` whenever a fetch is in flight, including a refresh over stale data. */
  fetching: boolean;
  /** Re-run the fetcher now (bypassing the TTL), passing `force: true`. */
  refetch: () => Promise<void>;
}

/**
 * Subscribe to a cached IPC read.
 *
 * @param key     Cache key, or `null` to disable fetching (e.g. while a required
 *                input like the project path is missing). The key must encode
 *                every input the fetcher closes over.
 * @param fetcher Async producer of the value. Called with `{ force }`.
 * @param options `ttl` overrides the default 30s freshness window.
 */
export function useIpcQuery<T>(
  key: string | null,
  fetcher: Fetcher<T>,
  options: { ttl?: number } = {},
): UseIpcQueryResult<T> {
  const ttl = options.ttl ?? DEFAULT_TTL_MS;

  // Keep the latest fetcher without making it a re-subscribe trigger — callers
  // pass fresh closures every render, but the key is the real dependency.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // `dispatch` from useReducer is referentially stable, so it doubles as our
  // listener identity for add/remove on the cache entry.
  const [, rerender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (key === null) return;
    const entry = getEntry<T>(key);
    entry.listeners.add(rerender);

    const isFresh = entry.settledAt > 0 && Date.now() - entry.settledAt < ttl;
    if (!entry.promise && !isFresh) {
      void runFetch(key, fetcherRef.current, false);
    }

    return () => {
      entry.listeners.delete(rerender);
    };
  }, [key, ttl]);

  const refetch = useCallback(async () => {
    if (key === null) return;
    await runFetch(key, fetcherRef.current, true);
  }, [key]);

  const entry = key !== null ? (cache.get(key) as CacheEntry<T> | undefined) : undefined;
  const loading = key !== null && (!entry || entry.status === "loading");
  const fetching = key !== null && (!entry || entry.promise !== undefined || entry.status === "loading");

  return {
    data: entry?.data,
    error: entry?.status === "error" ? entry.error : undefined,
    loading,
    fetching,
    refetch,
  };
}

/** Test-only: drop every cached entry. Call between tests so reads re-fetch. */
export function _resetIpcQueryCache(): void {
  cache.clear();
}
