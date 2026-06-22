import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkflowRunHistory } from "./WorkflowRunHistory";
import type { WorkflowRun } from "@/types";

function renderHistory(props: Partial<React.ComponentProps<typeof WorkflowRunHistory>> = {}) {
  const defaults: React.ComponentProps<typeof WorkflowRunHistory> = {
    runs: [],
    running: false,
    onRunNow: vi.fn(),
    onOpenSession: vi.fn(),
  };
  return render(
    <TooltipProvider>
      <WorkflowRunHistory {...defaults} {...props} />
    </TooltipProvider>
  );
}

const run = (over: Partial<WorkflowRun>): WorkflowRun => ({
  id: "run-1",
  workflow_id: "wf-1",
  session_id: "sess-1",
  status: "success",
  trigger: "manual",
  started_at: "2026-06-22T09:00:00.000Z",
  ended_at: "2026-06-22T09:00:05.000Z",
  error: null,
  ...over,
});

describe("WorkflowRunHistory", () => {
  it("shows an empty state when there are no runs", () => {
    renderHistory({ runs: [] });
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });

  it("renders run rows with status, trigger, and duration", () => {
    renderHistory({
      runs: [
        run({ id: "r1", status: "success" }),
        run({ id: "r2", status: "skipped", trigger: "cron", session_id: null, ended_at: null }),
      ],
    });

    expect(screen.getByText("Success")).toBeInTheDocument();
    expect(screen.getByText("Skipped")).toBeInTheDocument();
    expect(screen.getByText("manual")).toBeInTheDocument();
    expect(screen.getByText("cron")).toBeInTheDocument();
    // 5s duration is derived from started/ended timestamps.
    expect(screen.getByText("5s")).toBeInTheDocument();
  });

  it("shows the error message for a failed run", () => {
    renderHistory({ runs: [run({ status: "error", error: "boom" })] });
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("calls onRunNow when the button is clicked, and disables it while running", () => {
    const onRunNow = vi.fn();
    const { rerender } = renderHistory({ onRunNow });
    fireEvent.click(screen.getByRole("button", { name: /Run now/ }));
    expect(onRunNow).toHaveBeenCalledTimes(1);

    rerender(
      <TooltipProvider>
        <WorkflowRunHistory runs={[]} running onRunNow={onRunNow} onOpenSession={vi.fn()} />
      </TooltipProvider>
    );
    expect(screen.getByRole("button", { name: /Running/ })).toBeDisabled();
  });

  it("invokes onOpenSession with the run's session id", () => {
    const onOpenSession = vi.fn();
    renderHistory({ runs: [run({ session_id: "sess-42" })], onOpenSession });
    fireEvent.click(screen.getByRole("button", { name: "View session" }));
    expect(onOpenSession).toHaveBeenCalledWith("sess-42");
  });

  it("omits the session link when a run never reached a session", () => {
    renderHistory({ runs: [run({ session_id: null })] });
    expect(screen.queryByRole("button", { name: "View session" })).not.toBeInTheDocument();
  });
});
