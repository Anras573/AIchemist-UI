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
   * Omit (leave `undefined`) when there is no known persisted value yet.
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
  /** Immediately persist a still-pending debounced edit (e.g. on blur). No-op if nothing is pending. */
  flush: () => void;
  /** Revert to the value held before the last committed change. No-op once the undo window closes. */
  undo: () => void;
  /** True while the ~5s undo window is open (a previous value is available to restore). */
  canUndo: boolean;
}

const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_UNDO_MS = 5000;

// A value slot that distinguishes "no value tracked" from a tracked value that
// may itself be `undefined`, so the hook stays correct for `T` that includes
// `undefined` (e.g. `string | undefined`) instead of overloading `undefined` as
// the empty sentinel. Note this precision applies to *committed* values; the
// `initialValue` option is the one boundary where `undefined` still means "no
// baseline seeded yet" (the conventional meaning of an omitted optional prop).
type Slot<T> = { has: true; value: T } | { has: false };
const EMPTY: { has: false } = { has: false };

/**
 * Single source of the autosave "Saved ✓ / Undo / Save failed" affordance.
 *
 * Wraps a persist function and exposes `{ status, commit, flush, undo, canUndo }`.
 * `commit` debounces text edits and fires immediately for toggles; on success
 * it opens a short undo window during which `undo()` re-persists the value that
 * was in effect before the change. A still-pending debounced edit is flushed on
 * unmount so it is never silently dropped.
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

  // The value persisted *before* the in-flight edit — the undo target.
  const baselineRef = useRef<Slot<T>>(
    initialValue === undefined ? EMPTY : { has: true, value: initialValue },
  );
  const undoTargetRef = useRef<Slot<T>>(EMPTY);
  // The latest debounced value still waiting to be persisted (for flush).
  const pendingRef = useRef<Slot<T>>(EMPTY);
  // True once the field has been touched; gates the initialValue re-sync below.
  const dirtyRef = useRef(false);
  // Monotonic token per save. A save that resolves after a newer one was started
  // is stale and must not touch baseline/status/timer, or rapid immediate commits
  // (toggles/selects) could let an older completion clobber the newest value's state.
  const seqRef = useRef(0);

  const clear = (ref: { current: ReturnType<typeof setTimeout> | null }) => {
    if (ref.current) {
      clearTimeout(ref.current);
      ref.current = null;
    }
  };

  // Settings load asynchronously, so the real persisted value often arrives
  // after mount. Sync it into the undo baseline while the field is still clean
  // so the first edit can be undone back to it.
  useEffect(() => {
    if (!dirtyRef.current) {
      baselineRef.current = initialValue === undefined ? EMPTY : { has: true, value: initialValue };
    }
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
        baselineRef.current = { has: true, value };
        setStatus("saved");
        // Each completed save fully owns the undo state: arm it when the new
        // value differs from the prior baseline, otherwise clear any window left
        // over from an earlier save so a no-op re-save can't offer a stale Undo
        // that reverts too far back.
        if (trackUndo && undoTo.has && !Object.is(undoTo.value, value)) {
          undoTargetRef.current = { has: true, value: undoTo.value };
          setCanUndo(true);
        } else {
          undoTargetRef.current = EMPTY;
          setCanUndo(false);
        }
        // One timer both fades "Saved ✓" back to idle and closes the undo window.
        windowTimer.current = setTimeout(() => {
          setStatus((s) => (s === "saved" ? "idle" : s));
          setCanUndo(false);
          undoTargetRef.current = EMPTY;
          dirtyRef.current = false;
        }, undoMs);
      } catch (err) {
        if (seq !== seqRef.current) return;
        setError(err instanceof Error ? err : new Error(String(err)));
        setStatus("error");
        // A failed save must not leave a stale undo window from an earlier
        // successful save — its target no longer reflects the current state.
        setCanUndo(false);
        undoTargetRef.current = EMPTY;
        dirtyRef.current = false;
      }
    },
    [undoMs],
  );

  const commit = useCallback(
    (value: T, opts?: { immediate?: boolean }) => {
      dirtyRef.current = true;
      // Close any prior Saved/Undo window the moment a new edit starts. Otherwise
      // that window's timer could fire mid-edit, clear dirtyRef while pendingRef
      // still holds an unsaved value, and let the initialValue re-sync overwrite
      // the undo baseline. Starting a fresh edit also invalidates the old Undo.
      clear(windowTimer);
      undoTargetRef.current = EMPTY;
      setCanUndo(false);
      clear(debounceTimer);
      if (opts?.immediate || debounceMs <= 0) {
        pendingRef.current = EMPTY;
        void persist(value, true);
      } else {
        pendingRef.current = { has: true, value };
        debounceTimer.current = setTimeout(() => {
          pendingRef.current = EMPTY;
          void persist(value, true);
        }, debounceMs);
      }
    },
    [debounceMs, persist],
  );

  const flush = useCallback(() => {
    const pending = pendingRef.current;
    if (!pending.has) return;
    pendingRef.current = EMPTY;
    clear(debounceTimer);
    void persist(pending.value, true);
  }, [persist]);

  const undo = useCallback(() => {
    const target = undoTargetRef.current;
    if (!target.has) return;
    const value = target.value;
    undoTargetRef.current = EMPTY;
    pendingRef.current = EMPTY;
    setCanUndo(false);
    clear(windowTimer);
    clear(debounceTimer);
    // Don't track a fresh undo target for the revert itself (no redo loop).
    void persist(value, false);
  }, [persist]);

  // On unmount, flush a still-pending debounced edit so a quick unmount (e.g.
  // switching settings sections before the debounce fires) doesn't silently
  // drop the user's last change. Persist directly — the component is gone, so
  // skip the state updates persist() would make on an unmounted component.
  useEffect(
    () => () => {
      // Invalidate any in-flight persist() so its post-await code (setState /
      // undo-window timer) sees a stale seq and bails — no state updates on an
      // unmounted component.
      seqRef.current++;
      const pending = pendingRef.current;
      if (pending.has) {
        pendingRef.current = EMPTY;
        try {
          // try/catch handles a synchronous throw from save; .catch handles a
          // rejected promise. The component is gone, so there's no UI to surface
          // this on — but a failed final write means a lost edit, so log it.
          void Promise.resolve(saveRef.current(pending.value)).catch((err) => {
            console.error("useAutosave: failed to flush pending edit on unmount", err);
          });
        } catch (err) {
          console.error("useAutosave: failed to flush pending edit on unmount", err);
        }
      }
      clear(debounceTimer);
      clear(windowTimer);
    },
    [],
  );

  return { status, error, commit, flush, undo, canUndo };
}
