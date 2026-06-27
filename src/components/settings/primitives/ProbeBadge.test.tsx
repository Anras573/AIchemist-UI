import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProbeBadge, summarizeProbe } from "./ProbeBadge";

describe("summarizeProbe", () => {
  it("maps an ok result to Connected", () => {
    expect(summarizeProbe({ ok: true })).toEqual({ label: "Connected", tone: "ok" });
  });

  it("maps a disabled reason to a muted Disabled badge", () => {
    expect(summarizeProbe({ ok: false, reason: "Disabled in settings" })).toEqual({
      label: "Disabled",
      tone: "muted",
    });
  });

  it("recognises an invalid key", () => {
    expect(summarizeProbe({ ok: false, reason: "Invalid API key (401)" }).label).toBe("Invalid key");
  });

  it("recognises a base URL problem", () => {
    expect(summarizeProbe({ ok: false, reason: "404 — check ANTHROPIC_BASE_URL" }).label).toBe(
      "Check base URL",
    );
  });

  it("recognises an unconfigured key", () => {
    expect(summarizeProbe({ ok: false, reason: "GITHUB_TOKEN not set in ~/.aichemist/.env" }).label).toBe(
      "Not configured",
    );
  });

  it("recognises an unreachable / not-running provider", () => {
    expect(summarizeProbe({ ok: false, reason: "Ollama returned no models" }).label).toBe(
      "Not running",
    );
  });

  it("falls back to Unavailable for an unrecognised reason", () => {
    expect(summarizeProbe({ ok: false, reason: "kaboom" }).label).toBe("Unavailable");
  });
});

describe("ProbeBadge", () => {
  it("renders a loading badge while a probe is in flight (result undefined, checking)", () => {
    render(<ProbeBadge result={undefined} checking />);
    expect(screen.getByText("Checking…")).toBeInTheDocument();
  });

  it("falls back to Unavailable when the result is missing and not checking", () => {
    render(<ProbeBadge result={undefined} />);
    expect(screen.getByLabelText("Status: Unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Checking…")).not.toBeInTheDocument();
  });

  it("renders the Connected state for an ok probe", () => {
    render(<ProbeBadge result={{ ok: true }} />);
    expect(screen.getByLabelText("Status: Connected")).toBeInTheDocument();
  });

  it("renders a failure label", () => {
    render(<ProbeBadge result={{ ok: false, reason: "Invalid API key" }} />);
    expect(screen.getByLabelText("Status: Invalid key")).toBeInTheDocument();
  });
});
