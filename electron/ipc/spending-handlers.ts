import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import { getSpendingSummary } from "../spending";
import { getCopilotQuota } from "../agent/copilot";
import { parseDisabledProviders } from "../providers";
import { handle } from "./handle";

export function registerSpendingHandlers(db: Database): void {
  handle(CH.SPENDING_GET_SUMMARY, (_event, params) => getSpendingSummary(db, params));
  // Copilot's own plan/quota view. Short-circuits when the user disabled the
  // provider so opening the Spending tab never spins up the Copilot CLI for
  // someone who doesn't use it.
  handle(CH.SPENDING_COPILOT_QUOTA, async () => {
    if (parseDisabledProviders(process.env.AICHEMIST_DISABLED_PROVIDERS).has("copilot")) {
      return { ok: false as const, reason: "Disabled in settings" };
    }
    return getCopilotQuota();
  });
}
