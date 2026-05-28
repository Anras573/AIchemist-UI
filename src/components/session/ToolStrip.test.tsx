import { describe, it, expect, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { ToolStrip } from "./ToolStrip";
import { renderWithProviders } from "@/test/utils/renderWithProviders";

describe("ToolStrip", () => {
  it("hides GitHub tab when showGitHubTab is false", () => {
    renderWithProviders(<ToolStrip activeTab="changes" onSelect={vi.fn()} showGitHubTab={false} />);

    expect(screen.queryByRole("button", { name: "GitHub" })).not.toBeInTheDocument();
  });

  it("shows GitHub tab by default", () => {
    renderWithProviders(<ToolStrip activeTab="changes" onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "GitHub" })).toBeInTheDocument();
  });

  it("selects non-GitHub tabs normally when GitHub tab is hidden", () => {
    const onSelect = vi.fn();
    renderWithProviders(<ToolStrip activeTab="changes" onSelect={onSelect} showGitHubTab={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Files" }));

    expect(onSelect).toHaveBeenCalledWith("files");
  });
});
