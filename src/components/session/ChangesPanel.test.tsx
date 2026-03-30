import { describe, it, expect, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import { ChangesPanel } from "./ChangesPanel";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { useSessionStore } from "@/lib/store/useSessionStore";
import type { FileChange, Session } from "@/types";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFileChange(overrides: Partial<FileChange> = {}): FileChange {
  return {
    path: "/project/src/foo.ts",
    relativePath: "src/foo.ts",
    diff: [
      "--- src/foo.ts",
      "+++ src/foo.ts",
      "@@ -1,3 +1,4 @@",
      " unchanged",
      "-old line",
      "+new line",
      "+added line",
    ].join("\n"),
    operation: "write",
    ...overrides,
  };
}

function makeSession(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    project_id: "proj-1",
    title: id,
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

describe("DiffView line colouring", () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {} });
  });

  it("applies green styling to added lines", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    const lines = container.querySelectorAll("pre > div");
    const addedLine = Array.from(lines).find((el) =>
      el.textContent?.startsWith("+new line")
    );
    expect(addedLine?.className).toContain("text-green");
  });

  it("applies red styling to removed lines", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    const lines = container.querySelectorAll("pre > div");
    const removedLine = Array.from(lines).find((el) =>
      el.textContent?.startsWith("-old line")
    );
    expect(removedLine?.className).toContain("text-red");
  });

  it("applies blue styling to hunk headers (@@)", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    const lines = container.querySelectorAll("pre > div");
    const hunkLine = Array.from(lines).find((el) =>
      el.textContent?.startsWith("@@")
    );
    expect(hunkLine?.className).toContain("text-blue");
  });

  it("does not apply colour to context lines", () => {
    useSessionStore.getState().addSession(makeSession("sess-1"));
    useSessionStore.getState().setActiveSession("sess-1");
    useSessionStore.getState().addFileChange("sess-1", makeFileChange());

    const { container } = renderWithProviders(<ChangesPanel />);
    const lines = container.querySelectorAll("pre > div");
    const contextLine = Array.from(lines).find(
      (el) => el.textContent === " unchanged"
    );
    expect(contextLine?.className ?? "").not.toContain("text-green");
    expect(contextLine?.className ?? "").not.toContain("text-red");
    expect(contextLine?.className ?? "").not.toContain("text-blue");
  });
});

// ─── Empty states ─────────────────────────────────────────────────────────────

describe("ChangesPanel empty states", () => {
  beforeEach(() => {
    useSessionStore.setState({ activeSessionId: null, sessions: {}, sessionFileChanges: {} });
  });

  it("shows 'No active session' when there is no active session", () => {
    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText(/no active session/i)).toBeInTheDocument();
  });

  it("shows 'No file changes yet' when session exists but no changes", () => {
    useSessionStore.getState().addSession(makeSession("sess-empty"));
    useSessionStore.getState().setActiveSession("sess-empty");

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText(/no file changes yet/i)).toBeInTheDocument();
  });

  it("shows file path once a change is added", () => {
    useSessionStore.getState().addSession(makeSession("sess-with"));
    useSessionStore.getState().setActiveSession("sess-with");
    useSessionStore.getState().addFileChange("sess-with", makeFileChange());

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("src/foo.ts")).toBeInTheDocument();
  });

  it("shows 'delete' badge for delete operations", () => {
    useSessionStore.getState().addSession(makeSession("sess-del"));
    useSessionStore.getState().setActiveSession("sess-del");
    useSessionStore.getState().addFileChange("sess-del", makeFileChange({ operation: "delete" }));

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("delete")).toBeInTheDocument();
  });

  it("shows 'write' badge for write operations", () => {
    useSessionStore.getState().addSession(makeSession("sess-wr"));
    useSessionStore.getState().setActiveSession("sess-wr");
    useSessionStore.getState().addFileChange("sess-wr", makeFileChange({ operation: "write" }));

    renderWithProviders(<ChangesPanel />);
    expect(screen.getByText("write")).toBeInTheDocument();
  });

  it("shows 'No project path available' when active project has no path", () => {
    renderWithProviders(<ChangesPanel />);
    // No active project is set in projectStore → git diff section fallback
    expect(
      screen.getByText(/no project path available for git diff/i)
    ).toBeInTheDocument();
  });
});
