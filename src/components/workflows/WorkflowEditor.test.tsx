import { describe, it, expect, beforeEach, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { WorkflowEditor } from "./WorkflowEditor";
import type { Project } from "@/types";

const projects: Project[] = [
  {
    id: "proj-1",
    name: "Demo project",
    path: "/tmp/demo",
    created_at: "2026-01-01T00:00:00.000Z",
    config: { provider: "anthropic" },
  } as Project,
];

describe("WorkflowEditor — cron preview", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a 'Next run' preview for a valid cron expression", async () => {
    renderWithProviders(
      <WorkflowEditor
        workflow={null}
        defaultProjectId="proj-1"
        projects={projects}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    const cron = screen.getByLabelText("Schedule (cron)");
    fireEvent.change(cron, { target: { value: "0 9 * * *" } });

    expect(await screen.findByText(/Next run/)).toBeInTheDocument();
  });

  it("flags an invalid cron expression and disables saving", async () => {
    renderWithProviders(
      <WorkflowEditor
        workflow={null}
        defaultProjectId="proj-1"
        projects={projects}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Fill the required fields so only the cron validity gates the button.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "WF" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "do it" } });

    fireEvent.change(screen.getByLabelText("Schedule (cron)"), {
      target: { value: "not a cron" },
    });

    expect(await screen.findByText(/Invalid/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Create workflow/ })).toBeDisabled();
  });

  it("treats a blank schedule as manual-only (not an error)", () => {
    renderWithProviders(
      <WorkflowEditor
        workflow={null}
        defaultProjectId="proj-1"
        projects={projects}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/Manual only/)).toBeInTheDocument();
  });
});

describe("WorkflowEditor — autonomy warning", () => {
  beforeEach(() => vi.clearAllMocks());

  it("shows a prominent warning only when autonomy is autonomous", () => {
    renderWithProviders(
      <WorkflowEditor
        workflow={null}
        defaultProjectId="proj-1"
        projects={projects}
        onSaved={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    // Interactive by default → no warning.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Autonomy"), {
      target: { value: "autonomous" },
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/no human in the loop/i);

    // Switching back hides the warning again.
    fireEvent.change(screen.getByLabelText("Autonomy"), {
      target: { value: "interactive" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("WorkflowEditor — save", () => {
  beforeEach(() => vi.clearAllMocks());

  it("upserts the workflow with normalized fields and reports the result", async () => {
    const onSaved = vi.fn();
    const upsert = vi.fn().mockResolvedValue({
      id: "wf-1",
      project_id: "proj-1",
      name: "Triage",
      prompt: "Triage issues",
      provider: "anthropic",
      model: null,
      agent: null,
      skills: ["code-review"],
      cron: "0 9 * * *",
      enabled: true,
      session_strategy: "fresh",
      reuse_session_id: null,
      autonomy: "interactive",
      created_at: "2026-01-01T00:00:00.000Z",
      last_run_at: null,
    });

    renderWithProviders(
      <WorkflowEditor
        workflow={null}
        defaultProjectId="proj-1"
        projects={projects}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />,
      { ipc: { workflowUpsert: upsert } }
    );

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Triage  " } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Triage issues" } });
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "anthropic" } });
    fireEvent.change(screen.getByLabelText("Skills"), { target: { value: "code-review, , code-review" } });
    fireEvent.change(screen.getByLabelText("Schedule (cron)"), { target: { value: "0 9 * * *" } });

    fireEvent.click(screen.getByRole("button", { name: /Create workflow/ }));

    await waitFor(() => expect(upsert).toHaveBeenCalledTimes(1));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        name: "Triage",
        prompt: "Triage issues",
        provider: "anthropic",
        model: null,
        agent: null,
        skills: ["code-review"],
        cron: "0 9 * * *",
        autonomy: "interactive",
        sessionStrategy: "fresh",
      })
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });
});
