import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { AgentsSection } from "@/components/settings/sections/AgentsSection";
import type { AgentInfo } from "@/types";

const USER_AGENT: AgentInfo = {
  name: "code-reviewer",
  description: "Reviews diffs for correctness.",
  path: "/home/user/.claude/agents/code-reviewer.md",
  source: "global",
  editable: true,
};

const BUILTIN_AGENT: AgentInfo = {
  name: "general-purpose",
  description: "Built-in catch-all agent.",
  source: "sdk",
  editable: false,
};

describe("AgentsSection (hub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.getCopilotAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "---\n---\n\nAgent body." });
  });

  it("lists Claude agents for non-Copilot providers", async () => {
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([USER_AGENT, BUILTIN_AGENT]);

    renderWithProviders(<AgentsSection provider="ollama" projectPath="/proj" />);

    await waitFor(() => {
      expect(screen.getByText("code-reviewer")).toBeInTheDocument();
      expect(screen.getByText("general-purpose")).toBeInTheDocument();
    });
    expect(window.electronAPI.getClaudeAgents).toHaveBeenCalledWith("/proj");
    expect(window.electronAPI.getCopilotAgents).not.toHaveBeenCalled();
  });

  it("lists Copilot agents for the Copilot provider", async () => {
    vi.mocked(window.electronAPI.getCopilotAgents).mockResolvedValue([USER_AGENT]);

    renderWithProviders(<AgentsSection provider="copilot" projectPath="/proj" />);

    await waitFor(() => expect(screen.getByText("code-reviewer")).toBeInTheDocument());
    expect(window.electronAPI.getCopilotAgents).toHaveBeenCalledWith("/proj");
  });

  it("only offers an edit (pencil) button for editable file-backed agents", async () => {
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([USER_AGENT, BUILTIN_AGENT]);

    renderWithProviders(<AgentsSection provider="anthropic" projectPath="/proj" />);

    await waitFor(() => expect(screen.getByText("code-reviewer")).toBeInTheDocument());
    expect(screen.getAllByLabelText("View agent")).toHaveLength(2);
    expect(screen.getAllByLabelText("Edit agent")).toHaveLength(1);
  });

  it("opens the create modal from the New Agent button", async () => {
    const user = userEvent.setup();
    renderWithProviders(<AgentsSection provider="anthropic" projectPath="/proj" />);

    await user.click(await screen.findByRole("button", { name: "New Agent" }));

    expect(await screen.findByRole("heading", { name: "New Agent" })).toBeInTheDocument();
  });
});
