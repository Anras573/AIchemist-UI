import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "@/test/utils/renderWithProviders";
import { SpendingSection } from "@/components/settings/sections/SpendingSection";
import type { BudgetConfig, BudgetStatus } from "@/types";

const EMPTY_CONFIG: BudgetConfig = { period: "monthly", globalAmountUSD: null, providerAmountUSD: {} };

const EMPTY_STATUS: BudgetStatus = {
  period: "monthly",
  periodStart: "2026-07-01T00:00:00.000Z",
  periodEnd: "2026-08-01T00:00:00.000Z",
  global: { budgetUSD: null, spendUSD: 0, remainingUSD: null, burnRatePerDayUSD: 0 },
  byProvider: [],
};

describe("SpendingSection (hub)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(window.electronAPI.budgetRead).mockResolvedValue(EMPTY_CONFIG);
    vi.mocked(window.electronAPI.budgetGetStatus).mockResolvedValue(EMPTY_STATUS);
    vi.mocked(window.electronAPI.budgetWrite).mockImplementation(async (config) => config);
  });

  it("shows 'No budget set' when no global budget is configured", async () => {
    renderWithProviders(<SpendingSection />);

    await waitFor(() => expect(screen.getByText("No budget set")).toBeInTheDocument());
  });

  it("shows the configured budget, spend, and remaining balance", async () => {
    vi.mocked(window.electronAPI.budgetRead).mockResolvedValue({
      period: "monthly",
      globalAmountUSD: 100,
      providerAmountUSD: { anthropic: 50 },
    });
    vi.mocked(window.electronAPI.budgetGetStatus).mockResolvedValue({
      period: "monthly",
      periodStart: "2026-07-01T00:00:00.000Z",
      periodEnd: "2026-08-01T00:00:00.000Z",
      global: { budgetUSD: 100, spendUSD: 10, remainingUSD: 90, burnRatePerDayUSD: 2 },
      byProvider: [{ provider: "anthropic", budgetUSD: 50, spendUSD: 10, remainingUSD: 40, burnRatePerDayUSD: 2 }],
    });

    renderWithProviders(<SpendingSection />);

    await waitFor(() => expect(screen.getAllByText(/left of/).length).toBeGreaterThan(0));
    expect(screen.getAllByText("Anthropic (Claude)").length).toBeGreaterThan(0);
  });

  it("saves the edited global budget amount", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpendingSection />);

    await waitFor(() => expect(screen.getByLabelText("Global budget (USD)")).toBeInTheDocument());
    await user.type(screen.getByLabelText("Global budget (USD)"), "100");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(window.electronAPI.budgetWrite).toHaveBeenCalledWith(
        expect.objectContaining({ globalAmountUSD: 100 })
      )
    );
  });

  it("adds and removes a per-provider override", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SpendingSection />);

    await waitFor(() => expect(screen.getByLabelText("Add per-provider override")).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText("Add per-provider override"), "anthropic");

    expect(await screen.findByText("Anthropic (Claude)")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Remove Anthropic (Claude) override"));
    expect(screen.queryByLabelText("Remove Anthropic (Claude) override")).not.toBeInTheDocument();
  });

  it("surfaces an error (with a retry) instead of an indefinite loading state when the initial load fails", async () => {
    vi.mocked(window.electronAPI.budgetRead).mockRejectedValue(new Error("boom"));

    renderWithProviders(<SpendingSection />);

    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument());
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();

    const user = userEvent.setup();
    vi.mocked(window.electronAPI.budgetRead).mockResolvedValue(EMPTY_CONFIG);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByLabelText("Global budget (USD)")).toBeInTheDocument());
  });
});
