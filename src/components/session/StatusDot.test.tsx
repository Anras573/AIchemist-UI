import { describe, it, expect } from "vitest";
import { screen } from "@testing-library/react";
import { StatusDot } from "@/components/session/StatusDot";
import type { SessionStatus } from "@/types";
import { renderWithProviders } from "@/test/utils/renderWithProviders";

describe("StatusDot", () => {
  it.each<SessionStatus>(["idle", "running", "waiting_approval", "error", "complete"])(
    "renders with aria-label set to '%s'",
    (status) => {
      renderWithProviders(<StatusDot status={status} />);
      expect(screen.getByLabelText(status)).toBeInTheDocument();
    }
  );

  it("applies animate-pulse for running status", () => {
    renderWithProviders(<StatusDot status="running" />);
    expect(screen.getByLabelText("running")).toHaveClass("animate-pulse");
  });

  it("does not animate when idle", () => {
    renderWithProviders(<StatusDot status="idle" />);
    expect(screen.getByLabelText("idle")).not.toHaveClass("animate-pulse");
  });

  it("applies a green colour for running", () => {
    renderWithProviders(<StatusDot status="running" />);
    expect(screen.getByLabelText("running")).toHaveClass("bg-green-500");
  });

  it("applies an amber colour for waiting_approval", () => {
    renderWithProviders(<StatusDot status="waiting_approval" />);
    expect(screen.getByLabelText("waiting_approval")).toHaveClass("bg-amber-400");
  });

  it("applies a red colour for error", () => {
    renderWithProviders(<StatusDot status="error" />);
    expect(screen.getByLabelText("error")).toHaveClass("bg-red-500");
  });

  it("merges a custom className", () => {
    renderWithProviders(<StatusDot status="idle" className="my-custom" />);
    expect(screen.getByLabelText("idle")).toHaveClass("my-custom");
  });
});
