import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { makeMessage, makeProject, makeSession } from "@/test/utils/fixtures";

// Conversation (use-stick-to-bottom) requires ResizeObserver, absent in jsdom.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  useSessionStore.setState({
    sessions: {},
    activeSessionId: null,
    streamingText: {},
    liveToolCalls: {},
    pendingApprovals: {},
    pendingQuestions: {},
    sessionCompactions: {},
    queuedMessageIds: {},
    queuePaused: {},
  });
  useProjectStore.setState({ projects: [makeProject()], activeProjectId: "proj-1" });
  window.electronAPI.probeProviders = vi.fn().mockResolvedValue({
    anthropic: { ok: true },
    copilot: { ok: true },
    ollama: { ok: true },
    "openai-compatible": { ok: true },
    codex: { ok: true },
  });
});

describe("TimelinePanel empty state", () => {
  it("shows the provider chooser when there is no session", async () => {
    renderWithProviders(<TimelinePanel onNewSession={vi.fn()} />);
    expect(await screen.findByRole("radiogroup", { name: /session provider/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create a new session/i })).toBeInTheDocument();
  });

  it("omits the provider chooser when onNewSession is not provided", () => {
    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("No sessions yet")).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("prompts for the first message when the session has no history", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText(/send a message to start the conversation/i)).toBeInTheDocument();
  });
});

describe("TimelinePanel messages", () => {
  it("renders user and assistant messages, labelling the assistant's agent", () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", {
        messages: [
          makeMessage("m-1", { role: "user", content: "hello there" }),
          makeMessage("m-2", {
            role: "assistant",
            content: "hi back",
            created_at: "2024-01-01T00:00:02Z",
            agent: "code-reviewer",
          }),
        ],
      })
    );
    useSessionStore.getState().setActiveSession("sess-1");

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("hi back")).toBeInTheDocument();
    expect(screen.getByText("code-reviewer")).toBeInTheDocument();
  });

  it("marks queued messages with a badge", () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", { messages: [makeMessage("m-1", { content: "queued msg" })] })
    );
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({ queuedMessageIds: { "sess-1": ["m-1"] } });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("Queued")).toBeInTheDocument();
  });

  it("renders compaction markers between messages", () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", { messages: [makeMessage("m-1")] })
    );
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({
      sessionCompactions: {
        "sess-1": [
          {
            id: "c-1",
            session_id: "sess-1",
            trigger: "auto",
            pre_tokens: 42_000,
            timestamp: "2024-01-01T00:00:03Z",
          },
        ],
      },
    });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByLabelText("Conversation compacted")).toBeInTheDocument();
    expect(screen.getByText(/42k tokens summarised/)).toBeInTheDocument();
  });
});

describe("TimelinePanel live turn state", () => {
  it("shows the streaming bubble while the session is running", () => {
    useSessionStore.getState().addSession(makeSession("sess-1", { status: "running" }));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({ streamingText: { "sess-1": "partial resp" } });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("partial resp")).toBeInTheDocument();
    expect(screen.getByText(/agent is busy/i)).toBeInTheDocument();
  });

  it("renders live tool calls", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({
      liveToolCalls: {
        "sess-1": [{ toolCallId: "tc-1", toolName: "write_file", args: { path: "a.txt" } }],
      },
    });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("write_file")).toBeInTheDocument();
  });

  it("renders approval gates with allow/deny actions", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({
      pendingApprovals: {
        "sess-1": [
          {
            approvalId: "ap-1",
            toolCallId: "tc-1",
            toolName: "execute_bash",
            args: { command: "rm -rf /tmp/x" },
            resolve: vi.fn(),
          },
        ],
      },
    });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("execute_bash")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /allow once/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /deny/i })).toBeInTheDocument();
  });

  it("shows the queue recovery card when the queue is paused", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({
      queuePaused: { "sess-1": { remainingCount: 2, failedMessageId: "m-9" } },
    });

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText(/a queued message failed to send/i)).toBeInTheDocument();
    expect(screen.getByText(/2 messages still in queue/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});
