import { describe, it, expect, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { AgentEditorModal } from "@/components/session/AgentEditorModal";
import type { AgentInfo } from "@/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EDITABLE_AGENT: AgentInfo = {
  name: "haiku-agent",
  description: "Responds in haiku poems",
  path: "/home/user/.claude/agents/haiku-agent.md",
  editable: true,
};

const BUILTIN_AGENT: AgentInfo = {
  name: "sdk-builtin",
  description: "A built-in SDK agent",
  editable: false,
};

function renderModal(
  props: Partial<React.ComponentProps<typeof AgentEditorModal>> = {}
) {
  const defaults = {
    agent: null as AgentInfo | null,
    provider: "anthropic",
    projectPath: "/home/user/project",
    open: true,
    onClose: vi.fn(),
    onSaved: vi.fn(),
  };
  return { ...renderWithProviders(<AgentEditorModal {...defaults} {...props} />), ...defaults, ...props };
}

// ─── New agent mode ───────────────────────────────────────────────────────────

describe("AgentEditorModal — new agent", () => {
  it("shows 'New Agent' title", () => {
    renderModal({ agent: null });
    expect(screen.getByText("New Agent")).toBeInTheDocument();
  });

  it("shows name input and content textarea", () => {
    renderModal({ agent: null });
    expect(screen.getByPlaceholderText("my-agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue(/Write your agent system prompt/i)).toBeInTheDocument();
  });

  it("shows error when name is empty on save", async () => {
    renderModal({ agent: null });
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/agent name is required/i)).toBeInTheDocument();
  });

  it("shows error when name contains a space", async () => {
    renderModal({ agent: null });
    await userEvent.type(screen.getByPlaceholderText("my-agent"), "bad name");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/must not contain spaces or slashes/i)).toBeInTheDocument();
  });

  it("shows error when name contains a slash", async () => {
    renderModal({ agent: null });
    await userEvent.type(screen.getByPlaceholderText("my-agent"), "bad/name");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(screen.getByText(/must not contain spaces or slashes/i)).toBeInTheDocument();
  });

  it("calls ipc.createAgent and onSaved/onClose on successful create", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.createAgent).mockResolvedValue({ filePath: "/home/user/.claude/agents/new-agent.md" });

    renderModal({ agent: null, onSaved, onClose });
    await userEvent.type(screen.getByPlaceholderText("my-agent"), "new-agent");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(window.electronAPI.createAgent).toHaveBeenCalledWith(
        expect.objectContaining({ name: "new-agent", provider: "anthropic" })
      );
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows error when createAgent rejects", async () => {
    vi.mocked(window.electronAPI.createAgent).mockRejectedValue(new Error("disk full"));

    renderModal({ agent: null });
    await userEvent.type(screen.getByPlaceholderText("my-agent"), "new-agent");
    await userEvent.click(screen.getByRole("button", { name: /create/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to create agent/i)).toBeInTheDocument();
    });
  });

  it("does NOT show scope selector for anthropic provider", () => {
    renderModal({ agent: null, provider: "anthropic" });
    expect(screen.queryByLabelText(/scope/i)).not.toBeInTheDocument();
  });

  it("shows scope selector for copilot provider", () => {
    renderModal({ agent: null, provider: "copilot" });
    expect(screen.getByDisplayValue(/project/i)).toBeInTheDocument();
  });
});

// ─── Edit mode ────────────────────────────────────────────────────────────────

describe("AgentEditorModal — edit existing agent", () => {
  it("shows 'Edit Agent — <name>' title", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => {
      expect(screen.getByText("Edit Agent — haiku-agent")).toBeInTheDocument();
    });
  });

  it("loads file content via ipc.readFile", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "---\nname: haiku-agent\n---\nYou respond in haiku." });
    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => {
      expect(screen.getByDisplayValue(/you respond in haiku/i)).toBeInTheDocument();
    });
  });

  it("shows error when readFile fails", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ error: "file not found" });
    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => {
      expect(screen.getByText(/could not read agent file/i)).toBeInTheDocument();
    });
  });

  it("calls ipc.writeAgentFile and onSaved/onClose on save", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "original" });
    vi.mocked(window.electronAPI.writeAgentFile).mockResolvedValue(undefined);

    renderModal({ agent: EDITABLE_AGENT, onSaved, onClose });
    await waitFor(() => screen.getByDisplayValue("original"));

    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(window.electronAPI.writeAgentFile).toHaveBeenCalledWith({
        filePath: EDITABLE_AGENT.path,
        content: "original",
      });
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("shows error when writeAgentFile rejects", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    vi.mocked(window.electronAPI.writeAgentFile).mockRejectedValue(new Error("permission denied"));

    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => screen.getByDisplayValue("body"));
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(screen.getByText(/failed to save agent/i)).toBeInTheDocument();
    });
  });

  it("shows Delete button (not Confirm Delete) initially", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.queryByText(/confirm delete/i)).not.toBeInTheDocument();
  });

  it("first delete click shows 'Confirm Delete'", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(screen.getByRole("button", { name: /confirm delete/i })).toBeInTheDocument();
  });

  it("second delete click calls ipc.deleteAgentFile and onSaved/onClose", async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    vi.mocked(window.electronAPI.deleteAgentFile).mockResolvedValue(undefined);

    renderModal({ agent: EDITABLE_AGENT, onSaved, onClose });
    await waitFor(() => screen.getByRole("button", { name: /^delete$/i }));

    await userEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    await userEvent.click(screen.getByRole("button", { name: /confirm delete/i }));

    await waitFor(() => {
      expect(window.electronAPI.deleteAgentFile).toHaveBeenCalledWith(EDITABLE_AGENT.path);
      expect(onSaved).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });
});

// ─── Built-in (read-only) mode ────────────────────────────────────────────────

describe("AgentEditorModal — built-in agent (no path)", () => {
  it("shows non-editable placeholder text", async () => {
    renderModal({ agent: BUILTIN_AGENT });
    await waitFor(() => {
      expect(screen.getByDisplayValue(/built-in agent and cannot be edited/i)).toBeInTheDocument();
    });
  });

  it("does not show a Delete button for built-in agents", async () => {
    renderModal({ agent: BUILTIN_AGENT });
    await waitFor(() => screen.getByText(/built-in agent/i));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });
});

// ─── Read-only view (with path) ───────────────────────────────────────────────

describe("AgentEditorModal — read-only view (with path)", () => {
  it("shows 'Agent — haiku-agent' title", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => {
      expect(screen.getByText("Agent — haiku-agent")).toBeInTheDocument();
    });
  });

  it("shows 'Close' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => screen.getByText("Agent — haiku-agent"));
    expect(screen.getAllByRole("button", { name: /^close$/i }).length).toBeGreaterThan(0);
  });

  it("does NOT show a 'Save' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => screen.getByText("Agent — haiku-agent"));
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });

  it("does NOT show a 'Delete' button", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => screen.getByText("Agent — haiku-agent"));
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  });

  it("does NOT render a textarea", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => screen.getByText("Agent — haiku-agent"));
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("loads file content via ipc.readFile", async () => {
    vi.mocked(window.electronAPI.readFile).mockResolvedValue({ content: "body" });
    renderModal({ agent: EDITABLE_AGENT, readOnly: true });
    await waitFor(() => {
      expect(window.electronAPI.readFile).toHaveBeenCalledWith(EDITABLE_AGENT.path);
    });
  });
});

// ─── Read-only view (built-in, no path) ──────────────────────────────────────

describe("AgentEditorModal — read-only view (built-in, no path)", () => {
  it("shows 'Agent — sdk-builtin' title", () => {
    renderModal({ agent: BUILTIN_AGENT, readOnly: true });
    expect(screen.getByText("Agent — sdk-builtin")).toBeInTheDocument();
  });

  it("does NOT call ipc.readFile (no path to read)", () => {
    renderModal({ agent: BUILTIN_AGENT, readOnly: true });
    expect(window.electronAPI.readFile).not.toHaveBeenCalled();
  });

  it("does NOT show 'cannot be edited' text", () => {
    renderModal({ agent: BUILTIN_AGENT, readOnly: true });
    expect(screen.queryByText(/cannot be edited/i)).not.toBeInTheDocument();
  });

  it("shows the agent name in the content area", () => {
    renderModal({ agent: BUILTIN_AGENT, readOnly: true });
    expect(document.body.textContent).toContain("sdk-builtin");
  });

  it("shows 'Close' button and no 'Save' button", () => {
    renderModal({ agent: BUILTIN_AGENT, readOnly: true });
    expect(screen.getAllByRole("button", { name: /^close$/i }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /save/i })).not.toBeInTheDocument();
  });
});
