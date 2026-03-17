import { useRef, useState, useCallback } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface SplitPaneProps {
  left: React.ReactNode;
  right: React.ReactNode;
  defaultLeftPercent?: number;
  minLeftPercent?: number;
  maxLeftPercent?: number;
}

export function SplitPane({
  left,
  right,
  defaultLeftPercent = 60,
  minLeftPercent = 25,
  maxLeftPercent = 80,
}: SplitPaneProps) {
  const [leftPercent, setLeftPercent] = useState(defaultLeftPercent);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const prevLeftPercent = useRef(defaultLeftPercent);
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

  const toggleCollapse = useCallback(() => {
    if (rightCollapsed) {
      setLeftPercent(prevLeftPercent.current);
      setRightCollapsed(false);
    } else {
      prevLeftPercent.current = leftPercent;
      setLeftPercent(100);
      setRightCollapsed(true);
    }
  }, [rightCollapsed, leftPercent]);

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div style={{ width: `${leftPercent}%` }} className="flex flex-col overflow-hidden transition-[width] duration-200">
        {left}
      </div>

      {/* Drag handle + collapse toggle */}
      <div
        onMouseDown={onMouseDown}
        className={`relative w-1 flex-shrink-0 bg-border transition-colors group ${rightCollapsed ? "cursor-default" : "cursor-col-resize hover:bg-primary/30"}`}
      >
        <button
          onClick={toggleCollapse}
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 left-1/2 z-10
                     flex items-center justify-center
                     w-5 h-8 rounded-sm
                     bg-border hover:bg-muted-foreground/20
                     text-muted-foreground hover:text-foreground
                     opacity-0 group-hover:opacity-100
                     transition-opacity duration-150"
          title={rightCollapsed ? "Expand panel" : "Collapse panel"}
        >
          {rightCollapsed ? (
            <ChevronLeft className="h-3 w-3" />
          ) : (
            <ChevronRight className="h-3 w-3" />
          )}
        </button>
      </div>

      <div
        style={{ width: rightCollapsed ? "0%" : `${100 - leftPercent}%` }}
        className="flex flex-col overflow-hidden transition-[width] duration-200"
      >
        {right}
      </div>
    </div>
  );
}
