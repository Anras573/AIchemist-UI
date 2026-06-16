// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { McpServersPanel } from "@/components/session/McpServersPanel";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { Project, Session } from "@/types";

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "Test",
    status: "idle",
    created_at: "2024-01-01T00:00:00Z",
    messages: [],
    provider: "ollama",
    model: "llama3.2",
    branch: null,
    workspace_path: null,
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
      provider: "ollama",
      model: "llama3.2",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    ...overrides,
  };
}

describe("McpServersPanel", () => {
  beforeEach(() => {
    vi.mocked(window.electronAPI.listMcpServers).mockResolvedValue([
      {
        name: "context7",
        command: "npx -y @context7/mcp",
        transport: "stdio",
        connected: true,
        status: "Connected",
        source: "aichemist",
      },
      {
        name: "claude-only",
        command: "npx -y claude-mcp",
        transport: "stdio",
        connected: true,
        status: "Connected",
        source: "claude",
      },
    ]);
  });

  it("shows AIchemist-managed servers for Ollama sessions", async () => {
    useSessionStore.getState().addSession(makeSession());
    useSessionStore.getState().setActiveSession("sess-1");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<McpServersPanel />);

    expect(await screen.findByText("context7")).toBeInTheDocument();
    expect(screen.queryByText("claude-only")).not.toBeInTheDocument();
    expect(window.electronAPI.listMcpServers).toHaveBeenCalledTimes(1);
    expect(window.electronAPI.mcpProbeManaged).not.toHaveBeenCalled();
  });

  it("drops stale servers and shows the error when a refresh fails", async () => {
    useSessionStore.getState().addSession(makeSession());
    useSessionStore.getState().setActiveSession("sess-1");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");
    vi.mocked(window.electronAPI.mcpProbeManaged).mockRejectedValue(new Error("probe boom"));

    renderWithProviders(<McpServersPanel />);

    expect(await screen.findByText("context7")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Refresh"));

    // On a failed refresh the panel clears to the empty/error state rather than
    // leaving the previously-loaded servers on screen.
    await waitFor(() => {
      expect(screen.getByText(/probe boom/)).toBeInTheDocument();
    });
    expect(screen.queryByText("context7")).not.toBeInTheDocument();
  });
});
