import type React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { memo } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import { TimelinePanel } from "./TimelinePanel";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useSessionStore } from "@/lib/store/useSessionStore";
import { useProjectStore } from "@/lib/store/useProjectStore";
import { makeMessage, makeProject, makeSession } from "@/test/utils/fixtures";
import { OLDER_MESSAGES_PAGE_SIZE } from "@/lib/hooks/useLoadOlderMessages";

// jsdom has no layout engine, so react-virtuoso can't measure real item
// heights/viewport size — it would render an arbitrary (often near-empty)
// window of items. Replace it with a plain, fully-rendered list so timeline
// content assertions keep testing real behavior instead of virtualization
// internals. Wrapped in vi.fn() so tests can assert on the `data` it was
// handed (i.e. that the timeline is actually wired through Virtuoso).
type MockVirtuosoProps = {
  data?: unknown[];
  itemContent: (index: number, item: unknown, context?: unknown) => React.ReactNode;
  context?: unknown;
  components?: { Footer?: React.ComponentType<{ context?: unknown }> };
  startReached?: (index: number) => void;
  firstItemIndex?: number;
  scrollerRef?: (ref: HTMLElement | Window | null) => void;
  atBottomStateChange?: (atBottom: boolean) => void;
};

// Fake scroll container handed to the panel via Virtuoso's `scrollerRef`, so the
// auto-scroll path (ResizeObserver → scrollTo) can be asserted.
const scrollerEl = document.createElement("div");
const scrollToSpy = vi.fn();
scrollerEl.scrollTo = scrollToSpy as unknown as typeof scrollerEl.scrollTo;
let reportAtBottom: ((atBottom: boolean) => void) | undefined;

const mockVirtuoso = vi.fn((props: MockVirtuosoProps) => {
  props.scrollerRef?.(scrollerEl);
  reportAtBottom = props.atBottomStateChange;
  const Footer = props.components?.Footer;
  return (
    <div>
      {(props.data ?? []).map((item, index) => (
        <div key={index}>{props.itemContent(index, item, props.context)}</div>
      ))}
      {Footer && <Footer context={props.context} />}
    </div>
  );
});

vi.mock("react-virtuoso", () => ({
  Virtuoso: (props: MockVirtuosoProps) => mockVirtuoso(props),
}));

// Replace InputBar with a memoised render counter so tests can assert it does
// not re-render when streaming text changes (it keeps real `memo` semantics).
const { inputBarRenders } = vi.hoisted(() => ({ inputBarRenders: vi.fn() }));
vi.mock("./InputBar", () => ({
  InputBar: memo(function InputBarMock() {
    inputBarRenders();
    return <div data-testid="input-bar" />;
  }),
}));

// jsdom has no ResizeObserver; capture instances so tests can fire them.
class ResizeObserverStub {
  static instances: ResizeObserverStub[] = [];
  disconnected = false;
  constructor(public callback: () => void) {
    ResizeObserverStub.instances.push(this);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
}

beforeEach(() => {
  mockVirtuoso.mockClear();
  inputBarRenders.mockClear();
  scrollToSpy.mockClear();
  ResizeObserverStub.instances = [];
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  useSessionStore.setState({
    sessions: {},
    activeSessionId: null,
    streamingText: {},
    liveToolCalls: {},
    pendingApprovals: {},
    pendingQuestions: {},
    sessionCompactions: {},
    sessionHasMoreMessages: {},
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

  it("badges canvas-originated user messages with the canvas name", () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", {
        messages: [
          makeMessage("m-1", { role: "user", content: "your move", source: "canvas:connect4" }),
          makeMessage("m-2", { role: "user", content: "typed by me", created_at: "2024-01-01T00:00:02Z" }),
        ],
      })
    );
    useSessionStore.getState().setActiveSession("sess-1");

    renderWithProviders(<TimelinePanel />);
    const badges = screen.getAllByTestId("canvas-source-badge");
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent("connect4");
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

  it("orders messages and compaction markers chronologically regardless of input order", () => {
    // Messages passed out of chronological order — the timeline must still
    // render them (and an interleaved compaction marker) sorted by timestamp.
    useSessionStore.getState().addSession(
      makeSession("sess-1", {
        messages: [
          makeMessage("m-2", { content: "second message", created_at: "2024-01-01T00:00:02Z" }),
          makeMessage("m-1", { content: "first message", created_at: "2024-01-01T00:00:01Z" }),
          makeMessage("m-3", { content: "third message", created_at: "2024-01-01T00:00:04Z" }),
        ],
      })
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

    const { container } = renderWithProviders(<TimelinePanel />);
    const text = container.textContent ?? "";
    const positions = [
      text.indexOf("first message"),
      text.indexOf("second message"),
      text.indexOf("42k tokens summarised"),
      text.indexOf("third message"),
    ];
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("renders a long history through Virtuoso instead of mounting it all directly (issue #208)", () => {
    const messages = Array.from({ length: 500 }, (_, i) =>
      makeMessage(`m-${i}`, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `message ${i}`,
        created_at: `2024-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
      })
    );
    useSessionStore.getState().addSession(makeSession("sess-1", { messages }));
    useSessionStore.getState().setActiveSession("sess-1");

    renderWithProviders(<TimelinePanel />);

    expect(mockVirtuoso).toHaveBeenCalled();
    const { data } = mockVirtuoso.mock.calls.at(-1)![0];
    expect(data).toHaveLength(500);
  });

  it("loads and prepends an older page when Virtuoso's startReached fires (issue #208 follow-up)", async () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", {
        messages: [
          makeMessage("m-1", { content: "first loaded", created_at: "2024-01-01T00:00:10Z" }),
          makeMessage("m-2", { content: "second loaded", created_at: "2024-01-01T00:00:11Z" }),
        ],
      })
    );
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({ sessionHasMoreMessages: { "sess-1": true } });

    vi.mocked(window.electronAPI.getSession).mockResolvedValueOnce(
      makeSession("sess-1", {
        messages: [makeMessage("m-older", { content: "older message", created_at: "2024-01-01T00:00:05Z" })],
        has_more_messages: false,
      })
    );

    renderWithProviders(<TimelinePanel />);
    expect(screen.getByText("first loaded")).toBeInTheDocument();
    expect(screen.queryByText("older message")).not.toBeInTheDocument();

    const { startReached } = mockVirtuoso.mock.calls.at(-1)![0];
    startReached?.(0);

    await waitFor(() => expect(screen.getByText("older message")).toBeInTheDocument());
    expect(window.electronAPI.getSession).toHaveBeenCalledWith("sess-1", {
      limit: OLDER_MESSAGES_PAGE_SIZE,
      beforeMessageId: "m-1",
    });

    // The older page is prepended ahead of (not replacing) what was already loaded.
    expect(screen.getByText("first loaded")).toBeInTheDocument();
    expect(screen.getByText("second loaded")).toBeInTheDocument();
  });

  it("does not fetch an older page once has_more_messages is false", () => {
    useSessionStore.getState().addSession(
      makeSession("sess-1", { messages: [makeMessage("m-1", { content: "only message" })] })
    );
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.setState({ sessionHasMoreMessages: { "sess-1": false } });

    renderWithProviders(<TimelinePanel />);
    const { startReached } = mockVirtuoso.mock.calls.at(-1)![0];
    startReached?.(0);

    expect(window.electronAPI.getSession).not.toHaveBeenCalled();
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

  it("does not re-render the timeline list when streaming text or reasoning updates (issue #291)", async () => {
    useSessionStore.setState({
      sessions: {
        "sess-1": makeSession({
          id: "sess-1",
          status: "running",
          messages: [makeMessage({ id: "m1", role: "user", content: "hello" })],
        }),
      },
      activeSessionId: "sess-1",
    });
    renderWithProviders(<TimelinePanel onSendMessage={vi.fn()} />);
    await screen.findByText("hello");
    const rendersBefore = mockVirtuoso.mock.calls.length;
    const inputBarBefore = inputBarRenders.mock.calls.length;

    await act(async () => {
      useSessionStore.setState({ streamingText: { "sess-1": "first chunk" } });
    });
    await act(async () => {
      useSessionStore.setState({
        streamingText: { "sess-1": "first chunk second chunk" },
        sessionThinking: { "sess-1": "pondering" },
      });
    });

    // The leaf components picked the text up...
    expect(await screen.findByText(/second chunk/)).toBeInTheDocument();
    // ...but TimelinePanel (and therefore Virtuoso / the historical items /
    // the InputBar) did not commit again for the deltas.
    expect(mockVirtuoso.mock.calls.length).toBe(rendersBefore);
    expect(inputBarRenders.mock.calls.length).toBe(inputBarBefore);
  });

  describe("auto-scroll via footer ResizeObserver (issue #291)", () => {
    function renderRunning() {
      useSessionStore.setState({
        sessions: { "sess-1": makeSession({ id: "sess-1", status: "running" }) },
        activeSessionId: "sess-1",
      });
      renderWithProviders(<TimelinePanel onSendMessage={vi.fn()} />);
      const ro = ResizeObserverStub.instances.at(-1);
      expect(ro).toBeDefined();
      return ro!;
    }

    it("pins to the bottom when the footer grows and the user is at the bottom", () => {
      const ro = renderRunning();
      scrollToSpy.mockClear();
      act(() => ro.callback());
      expect(scrollToSpy).toHaveBeenCalled();
    });

    it("does not scroll when the user has scrolled up", () => {
      const ro = renderRunning();
      act(() => reportAtBottom?.(false));
      scrollToSpy.mockClear();
      act(() => ro.callback());
      expect(scrollToSpy).not.toHaveBeenCalled();
    });

    it("disconnects the observer on unmount", () => {
      useSessionStore.setState({
        sessions: { "sess-1": makeSession({ id: "sess-1", status: "running" }) },
        activeSessionId: "sess-1",
      });
      const { unmount } = renderWithProviders(<TimelinePanel onSendMessage={vi.fn()} />);
      const ro = ResizeObserverStub.instances.at(-1)!;
      unmount();
      expect(ro.disconnected).toBe(true);
    });
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
    expect(screen.getByText("Running write_file")).toBeInTheDocument();
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
    expect(screen.getByText("Awaiting approval to run execute_bash")).toBeInTheDocument();
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
