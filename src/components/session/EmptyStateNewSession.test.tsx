import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { EmptyStateNewSession } from "@/components/session/TimelinePanel";

vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelectorLogo: () => null,
}));

describe("EmptyStateNewSession", () => {
  it("preselects the project's default provider (Claude)", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession defaultProvider="anthropic" onNewSession={onNewSession} />
    );

    const claude = screen.getByRole("radio", { name: /use claude/i }) as HTMLInputElement;
    const copilot = screen.getByRole("radio", { name: /use copilot/i }) as HTMLInputElement;
    expect(claude.checked).toBe(true);
    expect(copilot.checked).toBe(false);
    expect(screen.getByText(/use claude/i).textContent).toMatch(/default/i);

    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));
    expect(onNewSession).toHaveBeenCalledWith("anthropic");
  });

  it("preselects Copilot when that is the project default", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession defaultProvider="copilot" onNewSession={onNewSession} />
    );

    const copilot = screen.getByRole("radio", { name: /use copilot/i }) as HTMLInputElement;
    expect(copilot.checked).toBe(true);
    expect(screen.getByText(/use copilot/i).textContent).toMatch(/default/i);

    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));
    expect(onNewSession).toHaveBeenCalledWith("copilot");
  });

  it("falls back to Claude when the project has no default provider", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession defaultProvider={null} onNewSession={onNewSession} />
    );

    const claude = screen.getByRole("radio", { name: /use claude/i }) as HTMLInputElement;
    expect(claude.checked).toBe(true);
    // Neither option should be marked as default when there's no project default
    expect(screen.queryByText(/\(default\)/i)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));
    expect(onNewSession).toHaveBeenCalledWith("anthropic");
  });

  it("passes the selected provider when the user switches radios", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession defaultProvider="anthropic" onNewSession={onNewSession} />
    );

    await userEvent.click(screen.getByRole("radio", { name: /use copilot/i }));
    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));

    expect(onNewSession).toHaveBeenCalledWith("copilot");
  });
});
