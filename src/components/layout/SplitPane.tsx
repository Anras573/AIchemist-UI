import { useRef, useState, useCallback } from "react";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  rightCollapsed?: boolean;
  defaultLeftPercent?: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
}

export function SplitPane({
  left,
  right,
  rightCollapsed = false,
  defaultLeftPercent = 60,
  minLeftPercent = 25,
  maxLeftPercent = 80,
}: SplitPaneProps) {
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback(() => {
    if (rightCollapsed) return;
    dragging.current = true;

    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((e.clientX - rect.left) / rect.width) * 100;
      setLeftPercent(Math.min(maxLeftPercent, Math.max(minLeftPercent, pct)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }, [minLeftPercent, maxLeftPercent, rightCollapsed]);

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div
        style={{ width: rightCollapsed ? "100%" : `${leftPercent}%` }}
        className="flex flex-col overflow-hidden transition-[width] duration-200"
      >
        {left}
      </div>

      {/* Drag handle — hidden when right pane is collapsed */}
      {!rightCollapsed && (
        <div
          onMouseDown={onMouseDown}
          className="w-1 cursor-col-resize bg-border hover:bg-primary/30 flex-shrink-0 transition-colors"
        />
      )}

      <div
        style={{ width: rightCollapsed ? "0%" : `${100 - leftPercent}%` }}
        className="flex flex-col overflow-hidden transition-[width] duration-200"
      >
        {right}
      </div>
    </div>
  );
}
