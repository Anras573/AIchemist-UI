import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { IpcError } from "@/lib/ipc";
import { CanvasTrustPrompt } from "@/components/session/CanvasTrustPrompt";
import type { CanvasTrustStatus } from "@/types";

const STATUS: CanvasTrustStatus = {
  definition: "widgets",
  path: "/proj/.agents/canvases/widgets",
  manifest: {
    name: "widgets",
    description: "A widget board.",
    version: 1,
    server: "server.mjs",
    ui: "ui/index.html",
  },
  dependencies: { names: [], hasPackageJson: false },
  contentHash: "hash-at-display-time",
  trusted: false,
  trustedAt: null,
};

describe("CanvasTrustPrompt (#227)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the displayed contentHash as expectedContentHash and calls onTrusted on success", async () => {
    vi.mocked(window.electronAPI.canvasTrustGrant).mockResolvedValue({
      trust: { project_id: "p1", definition: "widgets", content_hash: "hash-at-display-time", trusted_at: "now" },
      install: { ok: true, output: "" },
    });
    const onTrusted = vi.fn();
    const onStale = vi.fn();

    renderWithProviders(
      <CanvasTrustPrompt projectId="p1" status={STATUS} onTrusted={onTrusted} onStale={onStale} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Trust and run/i }));

    await waitFor(() => expect(onTrusted).toHaveBeenCalledTimes(1));
    expect(window.electronAPI.canvasTrustGrant).toHaveBeenCalledWith({
      projectId: "p1",
      definition: "widgets",
      expectedContentHash: "hash-at-display-time",
    });
    expect(onStale).not.toHaveBeenCalled();
  });

  it("calls onStale (not onTrusted) when the grant is refused as a conflict", async () => {
    vi.mocked(window.electronAPI.canvasTrustGrant).mockRejectedValue(
      new IpcError("conflict", "This canvas definition changed since it was reviewed.")
    );
    const onTrusted = vi.fn();
    const onStale = vi.fn();

    renderWithProviders(
      <CanvasTrustPrompt projectId="p1" status={STATUS} onTrusted={onTrusted} onStale={onStale} />
    );
    fireEvent.click(screen.getByRole("button", { name: /Trust and run/i }));

    await waitFor(() => expect(onStale).toHaveBeenCalledTimes(1));
    expect(onTrusted).not.toHaveBeenCalled();
    expect(screen.getByText(/changed since it was reviewed/i)).toBeInTheDocument();
  });
});
