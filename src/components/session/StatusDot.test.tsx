import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusDot } from "@/components/session/StatusDot";
import type { SessionStatus } from "@/types";

describe("StatusDot", () => {
  it.each<SessionStatus>(["idle", "running", "waiting_approval", "error", "complete"])(
    "renders with title set to '%s'",
    (status) => {
      render(<StatusDot status={status} />);
      expect(screen.getByTitle(status)).toBeInTheDocument();
    }
  );

  it("applies animate-pulse for running status", () => {
    render(<StatusDot status="running" />);
    expect(screen.getByTitle("running")).toHaveClass("animate-pulse");
  });

  it("does not animate when idle", () => {
    render(<StatusDot status="idle" />);
    expect(screen.getByTitle("idle")).not.toHaveClass("animate-pulse");
  });

  it("applies a green colour for running", () => {
    render(<StatusDot status="running" />);
    expect(screen.getByTitle("running")).toHaveClass("bg-green-500");
  });

  it("applies an amber colour for waiting_approval", () => {
    render(<StatusDot status="waiting_approval" />);
    expect(screen.getByTitle("waiting_approval")).toHaveClass("bg-amber-400");
  });

  it("applies a red colour for error", () => {
    render(<StatusDot status="error" />);
    expect(screen.getByTitle("error")).toHaveClass("bg-red-500");
  });

  it("merges a custom className", () => {
    render(<StatusDot status="idle" className="my-custom" />);
    expect(screen.getByTitle("idle")).toHaveClass("my-custom");
  });
});
