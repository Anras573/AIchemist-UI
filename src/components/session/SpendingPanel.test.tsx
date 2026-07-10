// @vitest-environment jsdom
import { beforeEach, describe, it, expect, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SpendingPanel } from "@/components/session/SpendingPanel";
import { useProjectStore } from "@/lib/store/useProjectStore";
import type { BudgetStatus, Project, SpendingSummary } from "@/types";

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "My Project",
    path: "/home/user/proj",
    created_at: "2024-01-01T00:00:00Z",
    config: {
      provider: "ollama",
      model: "llama3.2",
      approval_mode: "custom",
      approval_rules: [],
      custom_tools: [],
      allowed_tools: [],
      create_worktree_per_session: false,
    },
    ...overrides,
  };
}

const EMPTY_SUMMARY: SpendingSummary = {
  projectId: "proj-1",
  range: { since: null, until: null },
  periodSpendUSD: 0,
  periodConfidence: "exact",
  lifetimeSpendUSD: 0,
  lifetimeConfidence: "exact",
  byProvider: [],
};

const EMPTY_BUDGET: BudgetStatus = {
  period: "monthly",
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  global: { budgetUSD: null, spendUSD: 0, remainingUSD: null, burnRatePerDayUSD: 0 },
  byProvider: [],
};

function activateProject() {
  useProjectStore.getState().addProject(makeProject());
  useProjectStore.getState().setActiveProject("proj-1");
}

// Mirrors SpendingPanel's own formatUSD/formatTokens exactly, so assertions
// don't hard-code locale-specific formatting (grouping separators, currency
// symbol placement) that can differ from the CI/dev machine's default locale.
function usd(v: number): string {
  return v.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}
function tokens(v: number): string {
  return v.toLocaleString();
}

describe("SpendingPanel", () => {
  beforeEach(() => {
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue(EMPTY_SUMMARY);
    vi.mocked(window.electronAPI.budgetGetStatus).mockResolvedValue(EMPTY_BUDGET);
  });

  it("shows 'No project open' when there is no active project", () => {
    renderWithProviders(<SpendingPanel />);
    expect(screen.getByText("No project open")).toBeInTheDocument();
  });

  it("doesn't fetch spend or budget data when there is no active project", () => {
    renderWithProviders(<SpendingPanel />);
    expect(window.electronAPI.spendingGetSummary).not.toHaveBeenCalled();
    expect(window.electronAPI.budgetGetStatus).not.toHaveBeenCalled();
  });

  it("renders KPI cards for period spend, lifetime spend, remaining budget, and burn rate", async () => {
    activateProject();
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue({
      ...EMPTY_SUMMARY,
      periodSpendUSD: 12.5,
      lifetimeSpendUSD: 340.25,
    });
    vi.mocked(window.electronAPI.budgetGetStatus).mockResolvedValue({
      ...EMPTY_BUDGET,
      global: { budgetUSD: 100, spendUSD: 12.5, remainingUSD: 87.5, burnRatePerDayUSD: 3.2 },
    });

    renderWithProviders(<SpendingPanel />);

    expect(await screen.findByText(usd(12.5))).toBeInTheDocument();
    expect(screen.getByText(usd(340.25))).toBeInTheDocument();
    expect(screen.getByText(usd(87.5))).toBeInTheDocument();
    expect(screen.getByText(`of ${usd(100)} · monthly`)).toBeInTheDocument();
    expect(screen.getByText(`${usd(3.2)}/day`)).toBeInTheDocument();
  });

  it("shows 'No budget set' when no global budget is configured", async () => {
    activateProject();
    renderWithProviders(<SpendingPanel />);

    expect(await screen.findByText("No budget set")).toBeInTheDocument();
  });

  it("renders the provider breakdown table with tokens, cost, and percentage", async () => {
    activateProject();
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue({
      ...EMPTY_SUMMARY,
      periodSpendUSD: 20,
      byProvider: [
        {
          provider: "anthropic",
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 50,
          turn_count: 3,
          costUSD: 10,
          confidence: "exact",
          percentOfTotal: 100,
        },
      ],
    });

    renderWithProviders(<SpendingPanel />);

    expect(await screen.findByText("Claude")).toBeInTheDocument();
    expect(screen.getByText(tokens(1000))).toBeInTheDocument();
    expect(screen.getByText(tokens(500))).toBeInTheDocument();
    expect(screen.getByText(tokens(250))).toBeInTheDocument(); // cache_read + cache_creation
    expect(screen.getByText(usd(10))).toBeInTheDocument();
    expect(screen.getByText("100.0%")).toBeInTheDocument();
  });

  it("renders a placeholder instead of $0.00 for a row with unknown pricing coverage", async () => {
    activateProject();
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue({
      ...EMPTY_SUMMARY,
      periodSpendUSD: 0,
      periodConfidence: "unknown",
      byProvider: [
        {
          provider: "ollama",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          turn_count: 1,
          // estimateCost() always zeroes costUSD when confidence is "unknown" —
          // rendering that as $0.00 would misleadingly read as "this is free".
          costUSD: 0,
          confidence: "unknown",
          percentOfTotal: 0,
        },
      ],
    });

    renderWithProviders(<SpendingPanel />);

    // The table's Cost column shows a placeholder for the unknown-priced row —
    // note $0.00 (usd(0)) legitimately appears elsewhere on the page (the period/
    // lifetime KPI cards, which really are $0 here), so this only checks the
    // table cell itself, scoped past the ambiguous KPI-card matches.
    expect(await screen.findByText("Ollama")).toBeInTheDocument();
    const row = screen.getByText("Ollama").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText("—")).toBeInTheDocument();
    expect(within(row!).queryByText(usd(0))).not.toBeInTheDocument();
  });

  it("shows an empty-state message when there is no usage in the selected range", async () => {
    activateProject();
    renderWithProviders(<SpendingPanel />);

    expect(await screen.findByText("No usage recorded in this range.")).toBeInTheDocument();
  });

  it("shows the estimated badge only for non-exact confidence rows", async () => {
    activateProject();
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue({
      ...EMPTY_SUMMARY,
      periodSpendUSD: 10,
      byProvider: [
        {
          provider: "anthropic",
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          turn_count: 1,
          costUSD: 5,
          confidence: "exact",
          percentOfTotal: 50,
        },
        {
          provider: "copilot",
          input_tokens: 0,
          output_tokens: 80,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          turn_count: 1,
          costUSD: 5,
          confidence: "estimated",
          percentOfTotal: 50,
        },
      ],
    });

    renderWithProviders(<SpendingPanel />);

    await screen.findByText("Claude");
    expect(screen.getByText("Copilot")).toBeInTheDocument();
    expect(screen.getAllByLabelText("estimated cost")).toHaveLength(1);
    expect(screen.queryByLabelText("exact cost")).not.toBeInTheDocument();
  });

  it("marks the period/lifetime KPI totals as estimated when built from partial or unpriced data", async () => {
    activateProject();
    vi.mocked(window.electronAPI.spendingGetSummary).mockResolvedValue({
      ...EMPTY_SUMMARY,
      periodSpendUSD: 5,
      periodConfidence: "estimated",
      lifetimeSpendUSD: 50,
      lifetimeConfidence: "unknown",
    });

    renderWithProviders(<SpendingPanel />);

    expect(await screen.findByText(usd(5))).toBeInTheDocument();
    // One badge for the period total, one for the lifetime total.
    expect(screen.getAllByLabelText("estimated cost")).toHaveLength(1);
    expect(screen.getAllByLabelText("unknown cost")).toHaveLength(1);
  });

  it("does not mark the period/lifetime KPI totals when the underlying data is exact", async () => {
    activateProject();
    renderWithProviders(<SpendingPanel />);

    await waitFor(() => expect(window.electronAPI.spendingGetSummary).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText("estimated cost")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("unknown cost")).not.toBeInTheDocument();
  });

  it("switching time filters refetches the summary scoped to the new range", async () => {
    activateProject();
    const user = userEvent.setup();
    renderWithProviders(<SpendingPanel />);

    await waitFor(() => expect(window.electronAPI.spendingGetSummary).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: "30 days" }));

    await waitFor(() => expect(window.electronAPI.spendingGetSummary).toHaveBeenCalledTimes(2));
    const lastCall = vi.mocked(window.electronAPI.spendingGetSummary).mock.calls.at(-1)![0];
    expect(lastCall.projectId).toBe("proj-1");
    expect(lastCall.since).not.toBeNull();
  });

  it("reveals custom date inputs when the Custom filter is selected", async () => {
    activateProject();
    const user = userEvent.setup();
    renderWithProviders(<SpendingPanel />);
    await waitFor(() => expect(window.electronAPI.spendingGetSummary).toHaveBeenCalledTimes(1));

    expect(screen.queryByLabelText("Custom range start")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Custom" }));

    expect(screen.getByLabelText("Custom range start")).toBeInTheDocument();
    expect(screen.getByLabelText("Custom range end")).toBeInTheDocument();
  });
});
