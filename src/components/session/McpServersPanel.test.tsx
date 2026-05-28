import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
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
    },
    ...overrides,
  };
}

describe("McpServersPanel", () => {
  it("shows Ollama chat-only messaging without loading MCP servers", async () => {
    useSessionStore.getState().addSession(makeSession());
    useSessionStore.getState().setActiveSession("sess-1");
    useProjectStore.getState().addProject(makeProject());
    useProjectStore.getState().setActiveProject("proj-1");

    renderWithProviders(<McpServersPanel />);

    expect(await screen.findByText(/mcp servers are not injected into ollama sessions/i)).toBeInTheDocument();
    expect(window.electronAPI.listMcpServers).not.toHaveBeenCalled();
    expect(window.electronAPI.mcpProbeManaged).not.toHaveBeenCalled();
  });
});
