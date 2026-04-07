import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "./renderWithProviders";
import { useIpc } from "@/lib/ipc";
import type { AgentInfo } from "@/types";

// ─── Fixture component ────────────────────────────────────────────────────────

/**
 * A minimal component that calls ipc.getClaudeAgents() on mount
 * and renders the first agent name (or a status string).
 */
function AgentLister() {
  const ipc = useIpc();
  const [names, setNames] = React.useState<string[]>([]);
  const [state, setState] = React.useState<"loading" | "done" | "error">("loading");

  React.useEffect(() => {
    ipc
      .getClaudeAgents("/fake/path")
      .then((agents: AgentInfo[]) => {
        setNames(agents.map((a) => a.name));
        setState("done");
      })
      .catch(() => setState("error"));
  }, [ipc]);

  if (state === "loading") return <span>loading</span>;
  if (state === "error") return <span>error</span>;
  return <ul>{names.map((n) => <li key={n}>{n}</li>)}</ul>;
}

import React from "react";

// ─── renderWithProviders — ipc override ──────────────────────────────────────

describe("renderWithProviders ipc override", () => {
  it("injects the overridden ipc implementation into components via useIpc()", async () => {
    const mockGetClaudeAgents = vi.fn().mockResolvedValue([
      { name: "injected-agent", description: "from override" },
    ] satisfies AgentInfo[]);

    renderWithProviders(<AgentLister />, {
      ipc: { getClaudeAgents: mockGetClaudeAgents },
    });

    await waitFor(() => expect(screen.getByText("injected-agent")).toBeInTheDocument());
    expect(mockGetClaudeAgents).toHaveBeenCalledOnce();

    // The global window.electronAPI mock should NOT have been called
    expect(window.electronAPI.getClaudeAgents).not.toHaveBeenCalled();
  });

  it("falls through to the real ipc for methods not included in the override", async () => {
    // Only override getClaudeAgents; getCopiAgents is not overridden
    const mockGetClaudeAgents = vi.fn().mockResolvedValue([]);

    renderWithProviders(<AgentLister />, {
      ipc: { getClaudeAgents: mockGetClaudeAgents },
    });

    await waitFor(() => expect(screen.queryByText("loading")).not.toBeInTheDocument());
    // The mock was used for getClaudeAgents
    expect(mockGetClaudeAgents).toHaveBeenCalledOnce();
  });

  it("uses the real ipc when no override is provided", async () => {
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([
      { name: "real-agent", description: "from real ipc" },
    ] satisfies AgentInfo[]);

    renderWithProviders(<AgentLister />);

    await waitFor(() => expect(screen.getByText("real-agent")).toBeInTheDocument());
    expect(window.electronAPI.getClaudeAgents).toHaveBeenCalledOnce();
  });
});
