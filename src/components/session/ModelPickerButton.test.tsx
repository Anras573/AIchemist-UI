import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { ModelPickerButton } from "@/components/session/ModelPickerButton";

// Stub the ai-elements ModelSelector with a minimal, testable shell. The real
// component uses a command-palette style popover we don't need to exercise
// here — we only care about which items are rendered.
vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelector: ({ children, open, onOpenChange }: { children: React.ReactNode; open: boolean; onOpenChange: (o: boolean) => void }) => (
    <div data-testid="ms-root" data-open={open}>
      <button onClick={() => onOpenChange(!open)}>toggle</button>
      {children}
    </div>
  ),
  ModelSelectorTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModelSelectorContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ModelSelectorInput: () => null,
  ModelSelectorList: ({ children }: { children: React.ReactNode }) => <ul>{children}</ul>,
  ModelSelectorEmpty: () => null,
  ModelSelectorGroup: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <li data-group={heading}>
      <div>{heading}</div>
      <ul>{children}</ul>
    </li>
  ),
  ModelSelectorItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => (
    <li><button onClick={onSelect}>{children}</button></li>
  ),
  ModelSelectorLogo: () => null,
  ModelSelectorName: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ModelPickerButton", () => {
  it("shows only Anthropic models for an anthropic-locked session", async () => {
    vi.mocked(window.electronAPI.getCopilotModels).mockResolvedValue([
      { id: "gpt-5", name: "GPT-5" },
    ]);

    renderWithProviders(
      <ModelPickerButton sessionId="s1" provider="anthropic" model="claude-sonnet-4-6" />
    );

    await userEvent.click(screen.getByText("toggle"));

    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("GitHub Copilot")).not.toBeInTheDocument();
    expect(window.electronAPI.getCopilotModels).not.toHaveBeenCalled();
  });

  it("shows only Copilot models for a copilot-locked session", async () => {
    vi.mocked(window.electronAPI.getCopilotModels).mockResolvedValue([
      { id: "gpt-5", name: "GPT-5" },
    ]);

    renderWithProviders(
      <ModelPickerButton sessionId="s1" provider="copilot" model="gpt-5" />
    );

    await userEvent.click(screen.getByText("toggle"));

    await waitFor(() => {
      expect(screen.getByText("GitHub Copilot")).toBeInTheDocument();
    });
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(window.electronAPI.getCopilotModels).toHaveBeenCalled();
  });
});
