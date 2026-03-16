import { useRef, useState, useCallback } from "react";

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
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const onMouseDown = useCallback(() => {
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
  }, [minLeftPercent, maxLeftPercent]);

  return (
    <div ref={containerRef} className="flex h-full w-full overflow-hidden">
      <div style={{ width: `${leftPercent}%` }} className="flex flex-col overflow-hidden">
        {left}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="w-1 cursor-col-resize bg-border hover:bg-primary/30 flex-shrink-0 transition-colors"
      />

      <div style={{ width: `${100 - leftPercent}%` }} className="flex flex-col overflow-hidden">
        {right}
      </div>
    </div>
  );
}
