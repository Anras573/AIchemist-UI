/**
 * Replay budgeting for the self-driven providers (Ollama / OpenAI-compatible),
 * which rebuild the whole conversation from SQLite on every turn (issue #292).
 *
 * History is split into atomic *units* — a user message, or an assistant
 * message together with its tool calls/results — so a trim can never separate
 * a tool call from its result. Units are kept newest-first until the token
 * budget is spent, and the cut point is quantized to coarse steps so the
 * replayed prefix stays byte-identical across consecutive turns (prompt/KV
 * cache friendly) instead of sliding by one message per turn.
 */

/** Max chars of a *historical* tool result replayed to the model. */
export const MAX_REPLAYED_TOOL_RESULT_CHARS = 4000;
/** Whole old units are dropped in multiples of this many. */
export const TRIM_BATCH_UNITS = 8;
/** Fraction of the context window usable for replayed history. */
export const HISTORY_BUDGET_FRACTION = 0.7;
/** Conservative window when the model/endpoint doesn't report one. */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 32_768;

/** Rough token estimate (~4 chars/token); intentionally cheap and conservative. */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

export function truncateToolResult(text: string, max = MAX_REPLAYED_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  return `${text.slice(0, max)}\n…[truncated ${omitted} characters of an earlier tool result]`;
}

/** Token budget available for history, after the system prompt and current prompt. */
export function computeHistoryBudget(
  contextWindowTokens: number | null | undefined,
  reservedTokens: number,
): number {
  const window =
    contextWindowTokens && contextWindowTokens > 0 ? contextWindowTokens : DEFAULT_CONTEXT_WINDOW_TOKENS;
  return Math.max(0, Math.floor(window * HISTORY_BUDGET_FRACTION) - reservedTokens);
}

export interface HistoryUnit<T> {
  messages: T[];
  tokens: number;
  /** True when the unit's first message is a user message. */
  startsWithUser?: boolean;
}

/**
 * Keep the newest units that fit `budgetTokens`. The newest unit is always
 * kept (it holds the current prompt). The number of dropped units is rounded
 * up to a multiple of `batch` for prefix stability, never dropping the newest.
 */
export function trimUnitsToBudget<T>(
  units: HistoryUnit<T>[],
  budgetTokens: number,
  batch = TRIM_BATCH_UNITS,
): T[] {
  if (units.length === 0) return [];
  let total = 0;
  let cut = units.length - 1; // index of first kept unit; newest always kept
  total = units[cut].tokens;
  while (cut > 0 && total + units[cut - 1].tokens <= budgetTokens) {
    cut--;
    total += units[cut].tokens;
  }
  if (cut > 0) {
    cut = Math.min(units.length - 1, Math.ceil(cut / batch) * batch);
  }
  // Strict chat templates reject a conversation that doesn't open with a user
  // message: advance to the next user unit, never dropping the newest unit.
  if (cut > 0 && !units[cut].startsWithUser) {
    let next = cut;
    while (next < units.length && !units[next].startsWithUser) next++;
    if (next < units.length) cut = next;
  }
  return units.slice(cut).flatMap((u) => u.messages);
}
