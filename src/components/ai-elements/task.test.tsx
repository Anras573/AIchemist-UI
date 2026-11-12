import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Task, TaskContent, TaskItem, TaskTrigger } from "./task";

describe("Task", () => {
  it("renders the default trigger title and toggles its content", async () => {
    render(
      <Task defaultOpen={false}>
        <TaskTrigger title="Searching files" />
        <TaskContent>
          <TaskItem>Reading a.ts</TaskItem>
        </TaskContent>
      </Task>
    );
    const trigger = screen.getByRole("button", { name: /Searching files/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Reading a.ts")).toBeVisible();
  });

  it("keeps closed content mounted", () => {
    render(
      <Task defaultOpen={false}>
        <TaskTrigger title="t" />
        <TaskContent>
          <TaskItem>hidden step</TaskItem>
        </TaskContent>
      </Task>
    );
    expect(screen.getByText("hidden step", { selector: "*" })).toBeInTheDocument();
  });

  it("uses custom trigger children instead of the default row", () => {
    render(
      <Task>
        <TaskTrigger title="ignored">
          <span>my row</span>
        </TaskTrigger>
      </Task>
    );
    expect(screen.getByText("my row")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).not.toBeInTheDocument();
  });
});
