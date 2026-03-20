import React from "react";
import { render, type RenderOptions } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";

function Providers({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

/**
 * RTL render wrapped with app-level providers. Use this instead of bare
 * render() for any component that needs TooltipProvider in its tree.
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options?: Omit<RenderOptions, "wrapper">
) {
  return render(ui, { wrapper: Providers, ...options });
}
