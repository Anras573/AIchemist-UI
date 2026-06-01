import { useEffect, useCallback } from "react";
import { X } from "lucide-react";
import { ProjectSettingsContent } from "./ProjectSettingsContent";

interface ProjectSettingsSheetProps {
  projectId: string;
  onClose: () => void;
}

export function ProjectSettingsSheet({ projectId, onClose }: ProjectSettingsSheetProps) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    },
    [onClose]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Sheet */}
      <div
        role="dialog"
        aria-label="Project settings"
        className="fixed right-0 top-[38px] z-50 flex h-[calc(100vh-38px)] w-[420px] flex-col bg-background border-l shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b px-5 py-3.5">
          <h2 className="text-sm font-semibold">Project Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <ProjectSettingsContent projectId={projectId} />
      </div>
    </>
  );
}
