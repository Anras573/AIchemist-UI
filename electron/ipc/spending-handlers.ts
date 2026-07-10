import type { Database } from "better-sqlite3";
import * as CH from "../ipc-channels";
import { getSpendingSummary } from "../spending";
import { handle } from "./handle";

export function registerSpendingHandlers(db: Database): void {
  handle(CH.SPENDING_GET_SUMMARY, (_event, params) => getSpendingSummary(db, params));
}
