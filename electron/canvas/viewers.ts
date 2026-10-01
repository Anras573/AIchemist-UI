/**
 * Tracks which windows (by `webContents.id`) are currently showing each canvas
 * instance, so the host's panel-open flag (`setPanelOpen`, which gates idle-stop)
 * stays true while *any* view is open — the right-panel tab and/or a pop-out
 * window (#248). Closing one view must not release an instance another still shows.
 */
export class CanvasViewerTracker {
  private readonly viewers = new Map<string, Set<number>>();

  /** Registers a viewer; returns the instance's viewer count afterwards. */
  add(canvasId: string, senderId: number): number {
    let set = this.viewers.get(canvasId);
    if (!set) {
      set = new Set();
      this.viewers.set(canvasId, set);
    }
    set.add(senderId);
    return set.size;
  }

  /** Unregisters a viewer; returns the instance's viewer count afterwards. */
  remove(canvasId: string, senderId: number): number {
    const set = this.viewers.get(canvasId);
    if (!set) return 0;
    set.delete(senderId);
    if (set.size === 0) this.viewers.delete(canvasId);
    return set.size;
  }

  /** Drops a destroyed window from every instance; returns the ids left with no viewer. */
  releaseSender(senderId: number): string[] {
    const emptied: string[] = [];
    for (const [canvasId, set] of this.viewers) {
      if (set.delete(senderId) && set.size === 0) emptied.push(canvasId);
    }
    for (const id of emptied) this.viewers.delete(id);
    return emptied;
  }
}
