# Spending & budgets

AIchemist UI keeps a local ledger of your token usage and estimates what it costs, per provider and model — so you can see where the money goes without waiting for a bill.

## The Spending panel

Open the **Spending** tab in a session's right panel:

- **KPI cards** — total estimated spend, tokens used, and remaining budget / burn rate when a budget is set.
- **Provider breakdown** — spend split across Anthropic, Copilot, Codex, Ollama, and OpenAI-compatible usage.
- **Time ranges** — today, last 7 days, last 30 days, or a custom date range.

Costs are **estimates** computed locally from recorded token counts and known per-model prices; treat your provider's own billing as the source of truth. Rows indicate how confident the estimate is (e.g. when a model's price isn't known exactly). Local models (Ollama, self-hosted endpoints) naturally show as free. You can adjust or supply prices via pricing overrides in **Settings → Spending**.

## Budgets

Set a spending budget in **Settings → Spending**:

- A **global cap** in USD, resetting **daily**, **weekly**, or **monthly**.
- Optional **per-provider caps** (e.g. "$50 of my $100/month may go to Anthropic"), sharing the same reset period.

The Spending panel then shows **remaining balance** and **burn rate** (average spend per day this period) for each budget line. Budgets are informational — they warn you, they don't block requests.

Budget config is stored in `~/.aichemist/budget.json`.

## Historical data

Every completed turn is recorded to the usage ledger as it happens. On upgrade, AIchemist also **backfills** the ledger once per session by reconstructing token usage from each session's saved trace transcript, so sessions you started before the Spending feature shipped still show historical spend instead of $0.

This backfill only fills sessions that have **no** ledger entries at all — a session already recording live usage (i.e., you've run a turn in it since upgrading) is left as-is rather than partially topped up. If a session's transcript was later deleted or rotated, its pre-upgrade turns can't be recovered and won't appear in lifetime totals.
