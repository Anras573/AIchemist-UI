import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { EmptyStateNewSession } from "@/components/session/EmptyStateNewSession";

vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelectorLogo: () => null,
}));

// Mock IssueLinkPicker so tests are isolated from IPC
vi.mock("@/components/session/IssueLinkPicker", () => ({
  IssueLinkPicker: ({
    onChange,
  }: {
    selectedNumber: number | null;
    onChange: (n: number | null) => void;
    projectPath: string;
    className?: string;
  }) => (
    <button
      data-testid="issue-picker-mock"
      onClick={() => onChange(42)}
    >
      Pick issue
    </button>
  ),
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
    expect(onNewSession).toHaveBeenCalledWith("anthropic", undefined);
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
    expect(onNewSession).toHaveBeenCalledWith("copilot", undefined);
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
    expect(onNewSession).toHaveBeenCalledWith("anthropic", undefined);
  });

  it("passes the selected provider when the user switches radios", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession defaultProvider="anthropic" onNewSession={onNewSession} />
    );

    await userEvent.click(screen.getByRole("radio", { name: /use copilot/i }));
    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));

    expect(onNewSession).toHaveBeenCalledWith("copilot", undefined);
  });

  it("disables an unavailable radio and skips it when picking the initial selection", async () => {
    const onNewSession = vi.fn();
    renderWithProviders(
      <EmptyStateNewSession
        defaultProvider="anthropic"
        onNewSession={onNewSession}
        probes={{
          anthropic: { ok: false, reason: "no key" },
          copilot: { ok: true },
          ollama: { ok: true },
        }}
      />,
    );

    const claude = screen.getByRole("radio", { name: /use claude/i }) as HTMLInputElement;
    const copilot = screen.getByRole("radio", { name: /use copilot/i }) as HTMLInputElement;
    expect(claude.disabled).toBe(true);
    expect(claude.checked).toBe(false);
    // Initial selection skipped over disabled Claude → Copilot
    expect(copilot.checked).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));
    expect(onNewSession).toHaveBeenCalledWith("copilot", undefined);
  });

  it("disables the create button when the selected provider is unavailable", () => {
    renderWithProviders(
      <EmptyStateNewSession
        defaultProvider="copilot"
        onNewSession={vi.fn()}
        probes={{
          anthropic: { ok: false, reason: "no key" },
          copilot: { ok: false, reason: "no token" },
          ollama: { ok: false, reason: "not running" },
        }}
      />,
    );

    const button = screen.getByRole("button", { name: /create a new session/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("auto-reselects when probes arrive showing the current pick is unavailable", async () => {
    // Probes start as null (initial mount): pick the default. Then probes
    // arrive with the default disabled — selection must shift to the first
    // available provider so the Create button isn't stuck disabled.
    const onNewSession = vi.fn();
    const { rerender } = renderWithProviders(
      <EmptyStateNewSession defaultProvider="anthropic" onNewSession={onNewSession} />,
    );

    const claude = screen.getByRole("radio", { name: /use claude/i }) as HTMLInputElement;
    expect(claude.checked).toBe(true);

    rerender(
      <EmptyStateNewSession
        defaultProvider="anthropic"
        onNewSession={onNewSession}
        probes={{
          anthropic: { ok: false, reason: "no key" },
          copilot: { ok: true },
          ollama: { ok: true },
        }}
      />,
    );

    const copilotAfter = screen.getByRole("radio", { name: /use copilot/i }) as HTMLInputElement;
    const claudeAfter = screen.getByRole("radio", { name: /use claude/i }) as HTMLInputElement;
    expect(copilotAfter.checked).toBe(true);
    expect(claudeAfter.checked).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));
    expect(onNewSession).toHaveBeenCalledWith("copilot", undefined);
  });

  describe("issue picker integration", () => {
    it("does not render the issue picker when projectPath is not provided", () => {
      renderWithProviders(
        <EmptyStateNewSession defaultProvider="anthropic" onNewSession={vi.fn()} />,
      );
      expect(screen.queryByTestId("issue-picker-mock")).not.toBeInTheDocument();
    });

    it("renders the issue picker when projectPath is provided", () => {
      renderWithProviders(
        <EmptyStateNewSession
          defaultProvider="anthropic"
          onNewSession={vi.fn()}
          projectPath="/some/project"
        />,
      );
      expect(screen.getByTestId("issue-picker-mock")).toBeInTheDocument();
    });

    it("passes the selected issue number to onNewSession when an issue is picked", async () => {
      const onNewSession = vi.fn();
      renderWithProviders(
        <EmptyStateNewSession
          defaultProvider="anthropic"
          onNewSession={onNewSession}
          projectPath="/some/project"
        />,
      );

      // Simulate picking issue #42 via the mock picker
      await userEvent.click(screen.getByTestId("issue-picker-mock"));
      await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));

      expect(onNewSession).toHaveBeenCalledWith("anthropic", 42);
    });

    it("passes undefined as issueNumber when no issue is selected", async () => {
      const onNewSession = vi.fn();
      renderWithProviders(
        <EmptyStateNewSession
          defaultProvider="anthropic"
          onNewSession={onNewSession}
          projectPath="/some/project"
        />,
      );

      // Don't click the issue picker — no issue selected
      await userEvent.click(screen.getByRole("button", { name: /create a new session/i }));

      expect(onNewSession).toHaveBeenCalledWith("anthropic", undefined);
    });
  });
});
