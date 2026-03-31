// macOS-style title bar — draggable, centers app name, leaves room for traffic lights.
// `titleBarStyle: "hiddenInset"` in electron/main.ts keeps the native traffic lights
// visible in the top-left (~70px wide). We pad that side and make the rest draggable.

export function TitleBar() {
  return (
    <div
      className="flex h-[38px] w-full flex-shrink-0 items-center justify-center border-b bg-sidebar text-sidebar-foreground"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      data-drag-region="true"
    >
      {/* Left spacer matches native traffic-light button area */}
      <div className="w-[70px] flex-shrink-0" />

      <span className="flex-1 text-center text-sm font-medium select-none">
        AIchemist
      </span>

      {/* Mirror spacer so the text stays truly centered */}
      <div className="w-[70px] flex-shrink-0" />
    </div>
  );
}
