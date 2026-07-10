import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import { readBudgetConfig, writeBudgetConfig } from "../budget";
import { computeBudgetStatus } from "../budget-status";
import type { BudgetConfig } from "../../src/types/index";
import { handle } from "./handle";

export function registerBudgetHandlers(db: Database): void {
  handle(CH.BUDGET_READ, () => readBudgetConfig());
  handle(CH.BUDGET_WRITE, (_event, config: BudgetConfig) => {
    writeBudgetConfig(config);
    return readBudgetConfig();
  });
  handle(CH.BUDGET_GET_STATUS, () => computeBudgetStatus(db, readBudgetConfig()));
}
