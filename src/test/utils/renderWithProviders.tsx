import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ipc, IpcContext, type IpcClient } from "@/lib/ipc";

interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  ipc?: Partial<IpcClient>;
}

export function renderWithProviders(
  ui: React.ReactElement,
  { ipc: ipcOverride, ...options }: RenderWithProvidersOptions = {}
) {
  function Providers({ children }: { children: React.ReactNode }) {
    if (ipcOverride) {
      // Merge override with the real ipc so unspecified methods still work
      // (falling through to window.electronAPI mock in test setup)
      const merged = { ...ipc, ...ipcOverride } as IpcClient;
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
