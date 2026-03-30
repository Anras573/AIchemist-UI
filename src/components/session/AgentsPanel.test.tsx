import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { AgentsPanel } from "@/components/session/AgentsPanel";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { AgentInfo, Project, Session, SkillInfo } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agent: null,
    skills: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/proj",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
    },
    ...overrides,
  };
}

const AGENTS: AgentInfo[] = [
  { name: "research", description: "Searches the web for information", model: "claude-opus-4-5" },
  { name: "coder", description: "Writes and edits code" },
];

const SKILLS: SkillInfo[] = [
  { name: "ai-elements", description: "UI components for AI apps", path: "/proj/.agents/skills/ai-elements" },
  { name: "ai-sdk", description: "Vercel AI SDK helpers", path: "/proj/.agents/skills/ai-sdk" },
];

function setupStores(projectOverrides: Partial<Project> = {}) {
  const session = makeSession();
  const project = makeProject(projectOverrides);
  useSessionStore.getState().addSession(session);
  useSessionStore.getState().setActiveSession(session.id);
  useProjectStore.getState().addProject(project);
  useProjectStore.getState().setActiveProject(project.id);
  return { session, project };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("AgentsPanel", () => {
  it("shows loading state while agents are being fetched (Claude provider)", () => {
    setupStores();
    // Never resolves — stays in loading state
    vi.mocked(window.electronAPI.getClaudeAgents).mockReturnValue(new Promise(() => {}));
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    expect(screen.getByText(/loading agents/i)).toBeInTheDocument();
  });

  it("renders agent cards after loading", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText("research")).toBeInTheDocument();
      expect(screen.getByText("coder")).toBeInTheDocument();
    });
  });

  it("renders agent description and model badge", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText("Searches the web for information")).toBeInTheDocument();
      expect(screen.getByText("claude-opus-4-5")).toBeInTheDocument();
    });
  });

  it("shows Copilot fallback message when provider is copilot", () => {
    setupStores({
      config: {
        provider: "copilot",
        model: "gpt-4",
        approval_mode: "custom",
        approval_rules: [],
        custom_tools: [],
      },
    });
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    expect(screen.getByText(/not available when using github copilot/i)).toBeInTheDocument();
    expect(window.electronAPI.getClaudeAgents).not.toHaveBeenCalled();
  });

  it("shows error message when getClaudeAgents rejects", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockRejectedValue(
      new Error("claude not found")
    );
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/claude not found/i)).toBeInTheDocument();
    });
  });

  it("shows empty state when no agents are returned", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no sub-agents found/i)).toBeInTheDocument();
    });
  });

  it("clicking an agent sets it as the session agent", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => screen.getByText("research"));
    await userEvent.click(screen.getByText("research"));

    expect(useSessionStore.getState().sessionAgents["sess-1"]).toBe("research");
  });

  it("clicking the selected agent deselects it", async () => {
    setupStores();
    useSessionStore.getState().setSessionAgent("sess-1", "research");
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => screen.getByText("research"));
    await userEvent.click(screen.getByText("research"));

    expect(useSessionStore.getState().sessionAgents["sess-1"]).toBeUndefined();
  });

  it("renders skill cards after loading", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue(SKILLS);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText("ai-elements")).toBeInTheDocument();
      expect(screen.getByText("ai-sdk")).toBeInTheDocument();
    });
  });

  it("shows 'no skills installed' when skills array is empty", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue([]);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => {
      expect(screen.getByText(/no skills installed/i)).toBeInTheDocument();
    });
  });

  it("each agent card has a View agent button", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => screen.getByText("research"));
    const viewButtons = screen.getAllByTitle("View agent");
    expect(viewButtons).toHaveLength(AGENTS.length);
  });

  it("clicking the View agent button opens the viewer modal", async () => {
    setupStores();
    vi.mocked(window.electronAPI.getClaudeAgents).mockResolvedValue(AGENTS);
    vi.mocked(window.electronAPI.listSkills).mockResolvedValue([]);

    renderWithProviders(<AgentsPanel />);

    await waitFor(() => screen.getByText("research"));
    const [researchViewButton] = screen.getAllByTitle("View agent");
    await userEvent.click(researchViewButton);

    expect(screen.getByText("Agent — research")).toBeInTheDocument();
  });
});
