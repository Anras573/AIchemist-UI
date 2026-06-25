import { useCallback, useEffect, useRef, useState } from "react";

export type AutosaveStatus = "idle" | "saving" | "saved" | "error";

export interface UseAutosaveOptions<T> {
  /** Debounce window for non-immediate `commit()` calls (text fields). Default 500ms. */
  debounceMs?: number;
  /** How long the "Saved ✓ / Undo" affordance stays available after a save. Default 5000ms. */
  undoMs?: number;
  /**
   * The currently-persisted value. Used as the undo baseline for the first edit
   * (before any save has established one). Because settings load asynchronously,
   * it is re-synced into the baseline whenever it changes while the field is
   * clean (no pending/committed edit), so undo works from the very first change.
   */
  initialValue?: T;
}

export interface UseAutosave<T> {
  /** `idle` → `saving` → `saved` (or `error`). Returns to `idle` once the undo window closes. */
  status: AutosaveStatus;
  /** The error from the last failed save, or `null`. */
  error: Error | null;
  /**
   * Persist `value`. Debounced by `debounceMs` for text input; pass
   * `{ immediate: true }` for toggles / selects to save on the spot.
   */
  commit: (value: T, opts?: { immediate?: boolean }) => void;
  /** Revert to the value held before the last committed change. No-op once the undo window closes. */
  undo: () => void;
  /** True while the ~5s undo window is open (a previous value is available to restore). */
  canUndo: boolean;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_UNDO_MS = 5000;

/**
 * Single source of the autosave "Saved ✓ / Undo / Save failed" affordance.
 *
 * Wraps a persist function and exposes `{ status, commit, undo, canUndo }`.
 * `commit` debounces text edits and fires immediately for toggles; on success
 * it opens a short undo window during which `undo()` re-persists the value that
 * was in effect before the change.
 */
export function useAutosave<T>(
  save: (value: T) => void | Promise<void>,
  options: UseAutosaveOptions<T> = {},
): UseAutosave<T> {
  const { debounceMs = DEFAULT_DEBOUNCE_MS, undoMs = DEFAULT_UNDO_MS, initialValue } = options;

  const [status, setStatus] = useState<AutosaveStatus>("idle");
  const [error, setError] = useState<Error | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  // Keep the latest save fn without re-creating callbacks / re-arming timers.
  const saveRef = useRef(save);
  saveRef.current = save;

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const windowTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The value that was persisted *before* the in-flight edit — the undo target.
  const baselineRef = useRef<T | undefined>(initialValue);
  const undoTargetRef = useRef<T | undefined>(undefined);
  // True once the field has been touched; gates the initialValue re-sync below.
  const dirtyRef = useRef(false);
  // Monotonic token per save. A save that resolves after a newer one was started
  // is stale and must not touch baseline/status/timer, or rapid immediate commits
  // (toggles/selects) could let an older completion clobber the newest value's state.
  const seqRef = useRef(0);

  const clear = (ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  // Settings load asynchronously, so the real persisted value often arrives
  // after mount. Sync it into the undo baseline while the field is still clean
  // so the first edit can be undone back to it.
  useEffect(() => {
    if (!dirtyRef.current) baselineRef.current = initialValue;
  }, [initialValue]);

  const persist = useCallback(
    async (value: T, trackUndo: boolean) => {
      clear(windowTimer);
      const undoTo = baselineRef.current;
      const seq = ++seqRef.current;
      setStatus("saving");
      setError(null);
      try {
        await saveRef.current(value);
        // A newer commit superseded this one — drop its result so it can't
        // overwrite the latest value's baseline or arm a stale window timer.
        if (seq !== seqRef.current) return;
        baselineRef.current = value;
        setStatus("saved");
        if (trackUndo && undoTo !== undefined && !Object.is(undoTo, value)) {
          undoTargetRef.current = undoTo;
          setCanUndo(true);
        }
        // One timer both fades "Saved ✓" back to idle and closes the undo window.
        windowTimer.current = setTimeout(() => {
          setStatus((s) => (s === "saved" ? "idle" : s));
          setCanUndo(false);
          undoTargetRef.current = undefined;
          dirtyRef.current = false;
        }, undoMs);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
        dirtyRef.current = false;
      }
    },
    [undoMs],
  );

  const commit = useCallback(
    (value: T, opts?: { immediate?: boolean }) => {
      dirtyRef.current = true;
      clear(debounceTimer);
      if (opts?.immediate || debounceMs <= 0) {
        void persist(value, true);
      } else {
        debounceTimer.current = setTimeout(() => void persist(value, true), debounceMs);
      }
    },
    [debounceMs, persist],
  );

  const undo = useCallback(() => {
    const target = undoTargetRef.current;
    if (target === undefined) return;
    undoTargetRef.current = undefined;
    setCanUndo(false);
    clear(windowTimer);
    clear(debounceTimer);
    // Don't track a fresh undo target for the revert itself (no redo loop).
    void persist(target, false);
  }, [persist]);

  // Drop pending timers on unmount.
  useEffect(
    () => () => {
      clear(debounceTimer);
      clear(windowTimer);
    },
    [],
  );

  return { status, error, commit, undo, canUndo };
}
