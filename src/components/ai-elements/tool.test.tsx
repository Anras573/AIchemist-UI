import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
  type ToolPart,
} from "./tool";

function renderTool(state: ToolPart["state"], extra?: React.ReactNode) {
  return render(
    <Tool defaultOpen>
      <ToolHeader type="dynamic-tool" toolName="write_file" state={state} />
      <ToolContent>{extra}</ToolContent>
    </Tool>
  );
}

describe("Tool", () => {
  it.each([
    ["input-available", "Running write_file"],
    ["input-streaming", "Running write_file"],
    ["output-available", "Ran write_file"],
    ["output-error", "Failed to run write_file"],
    ["output-denied", "Denied write_file"],
    ["approval-requested", "Awaiting approval to run write_file"],
  ] as const)("titles the %s state", (state, title) => {
    renderTool(state);
    expect(screen.getByText(title)).toBeInTheDocument();
  });

  it("marks running and error lines with a status", () => {
    const { unmount } = renderTool("input-available");
    expect(
      screen.getByText("Running write_file").closest("[data-slot=trace-line]")
    ).toHaveAttribute("data-status", "running");
    unmount();
    renderTool("output-error");
    expect(
      screen
        .getByText("Failed to run write_file")
        .closest("[data-slot=trace-line]")
    ).toHaveAttribute("data-status", "error");
  });

  it("renders input parameters and an error message", () => {
    renderTool(
      "output-error",
      <>
        <ToolInput input={{ path: "a.txt" }} />
        <ToolOutput output={undefined} errorText="ENOENT" />
      </>
    );
    expect(screen.getByText("Parameters")).toBeInTheDocument();
    expect(screen.getByText("Error")).toBeInTheDocument();
    expect(screen.getByText("ENOENT")).toBeInTheDocument();
  });

  it("renders nothing for an empty output", () => {
    const { container } = render(
      <ToolOutput output={undefined} errorText={undefined} />
    );
    expect(container).toBeEmptyDOMElement();
  });
});
