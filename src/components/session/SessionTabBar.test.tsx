import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SessionTabBar } from "@/components/session/SessionTabBar";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { Session } from "@/types";

// Stub the model logo — it has no bearing on tab rendering logic
vi.mock("@/components/ai-elements/model-selector", () => ({
  ModelSelectorLogo: () => null,
}));

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "sess-1",
    project_id: "proj-1",
    title: "My session",
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

describe("SessionTabBar", () => {
  it("renders a tab for each session returned by listSessions", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "First session" }),
      makeSession({ id: "sess-2", title: "Second session" }),
    ]);

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    await screen.findByText("First session");
    await screen.findByText("Second session");
  });

  it("shows the model label on the active session tab", async () => {
    const session = makeSession({
      id: "sess-1",
      title: "Active session",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([session]);

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    // Wait for tabs to render then verify the model label appears
    await screen.findByText("Active session");
    await waitFor(() => {
      expect(screen.getByText("Claude Sonnet 4.6")).toBeInTheDocument();
    });
  });

  it("calls ipc.deleteSession and removes the tab when the close button is clicked", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "Closeable" }),
    ]);
    vi.mocked(window.electronAPI.deleteSession).mockResolvedValue(undefined);

    renderWithProviders(<SessionTabBar projectId="proj-1" />);
    await screen.findByText("Closeable");

    // The close button is a span[role=button] with aria-label="Close session"
    const closeBtn = screen.getByLabelText("Close session");
    await userEvent.click(closeBtn);

    expect(window.electronAPI.deleteSession).toHaveBeenCalledWith("sess-1");
    await waitFor(() => {
      expect(screen.queryByText("Closeable")).not.toBeInTheDocument();
    });
  });

  it("calls ipc.createSession with no provider override when the main new-session button is clicked", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    const newBtn = screen.getByLabelText("New session (project default)");
    await userEvent.click(newBtn);

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", undefined);
  });

  it("calls ipc.createSession with 'anthropic' when New Claude Session is picked from the split-button menu", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    await userEvent.click(screen.getByLabelText("New session with specific provider"));
    await userEvent.click(await screen.findByText("New Claude Session"));

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", "anthropic");
  });

  it("calls ipc.createSession with 'copilot' when New Copilot Session is picked", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);
    vi.mocked(window.electronAPI.createSession).mockResolvedValue(
      makeSession({ id: "sess-new", title: "New session" })
    );

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    await userEvent.click(screen.getByLabelText("New session with specific provider"));
    await userEvent.click(await screen.findByText("New Copilot Session"));

    expect(window.electronAPI.createSession).toHaveBeenCalledWith("proj-1", "copilot");
  });

  it("reflects session status via StatusDot aria-label", async () => {
    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([
      makeSession({ id: "sess-1", title: "Running session", status: "running" }),
    ]);

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    await screen.findByText("Running session");
    expect(screen.getByLabelText("running")).toBeInTheDocument();
  });

  it("does not render tabs for sessions from a different project", async () => {
    // listSessions is scoped to projectId — store may contain cross-project sessions
    const foreignSession = makeSession({
      id: "sess-foreign",
      project_id: "proj-other",
      title: "Foreign session",
    });
    useSessionStore.getState().addSession(foreignSession);

    vi.mocked(window.electronAPI.listSessions).mockResolvedValue([]);

    renderWithProviders(<SessionTabBar projectId="proj-1" />);

    await waitFor(() => {
      expect(screen.queryByText("Foreign session")).not.toBeInTheDocument();
    });
  });
});
