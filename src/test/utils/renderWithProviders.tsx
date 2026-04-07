import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IpcContext, type IpcClient } from "@/lib/ipc";

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  ipc?: Partial<IpcClient>;
}

export function renderWithProviders(
  ui: React.ReactElement,
  { ipc: ipcOverride, ...options }: RenderWithProvidersOptions = {}
) {
  // Build the wrapper lazily so we can capture ipcOverride in closure
  function Providers({ children }: { children: React.ReactNode }) {
    if (ipcOverride) {
      // Merge override with the real ipc so unspecified methods still work
      // (falling through to window.electronAPI mock in test setup)
      const { ipc: realIpc } = require("@/lib/ipc") as { ipc: IpcClient };
      const merged = { ...realIpc, ...ipcOverride } as IpcClient;
      return (
        <IpcContext.Provider value={merged}>
          <TooltipProvider>{children}</TooltipProvider>
        </IpcContext.Provider>
      );
    }
    return <TooltipProvider>{children}</TooltipProvider>;
  }

  return render(ui, { wrapper: Providers, ...options });
}
