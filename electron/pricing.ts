/**
 * Cost-calculation engine — turns raw token counts (from the usage ledger,
 * see `electron/usage-ledger.ts`) into estimated USD spend, provider/model
 * aware. This is the foundation the Spending panel (follow-up, see epic #155)
 * reads from; this module does NOT compute perfect billing parity with a
 * provider's actual invoice (out of scope — see epic #155), only a
 * best-effort estimate from published per-token pricing.
 *
 * Pricing data comes from two places, manual overrides taking priority:
 * 1. `readPricingOverrides()` (`electron/pricing-overrides.ts`) — user-configured
 *    rates for provider/model pairs the catalog can't price (self-hosted models,
 *    custom endpoints, GitHub Copilot's flat-subscription models which the
 *    catalog ships with no per-token cost at all).
 * 2. `tokenlens`'s bundled models.dev catalog (`defaultCatalog` + `getModelMeta`).
 *
 * `estimateCost()` is deliberately generic over `{ provider, model, usage }` so
 * the SAME function backs both an ad hoc single-turn estimate (a `UsageLedgerRow`)
 * and the provider/model breakdown table (loop `getUsageByProviderModel()` rows
 * through it and sum — costing an aggregate requires per-model granularity, since
 * a provider's rows may span several differently-priced models).
 */
import { getModelMeta, defaultCatalog } from "tokenlens";
import type { Provider, SessionUsage } from "../src/types/index";
import { parseCompositeModelId } from "./openai-endpoints";
import { readPricingOverrides, overrideKey, type PricingRates } from "./pricing-overrides";

export type CostConfidence = "exact" | "estimated" | "unknown";

export interface CostEstimate {
  inputUSD: number;
  outputUSD: number;
  cacheReadUSD: number;
  cacheCreationUSD: number;
  totalUSD: number;
  /**
   * `exact` — full token fidelity and a known price.
   * `estimated` — a known price, but this provider's token reporting is known
   *   to be partial (see `PARTIAL_FIDELITY_PROVIDERS`), so the estimate may
   *   understate the true cost.
   * `unknown` — no pricing data for this provider/model; fields are all 0 and
   *   must not be treated as "free".
   */
  confidence: CostConfidence;
}

const ZERO_COST: CostEstimate = {
  inputUSD: 0,
  outputUSD: 0,
  cacheReadUSD: 0,
  cacheCreationUSD: 0,
  totalUSD: 0,
  confidence: "unknown",
};

/**
 * Providers with known-incomplete token reporting today (see epic #155's
 * fidelity table): Copilot's input/cache counts are effectively unknown, and
 * Ollama never reports cache tokens. Even when a price resolves, a turn from
 * one of these providers can only be an `estimated` cost, never `exact`.
 */
const PARTIAL_FIDELITY_PROVIDERS: ReadonlySet<Provider> = new Set(["copilot", "ollama"]);

/**
 * Maps our provider ids to the tokenlens/models.dev catalog's provider key.
 * `codex` and `openai-compatible` both run OpenAI-shaped models most of the
 * time, so both are looked up against the "openai" catalog entry; an
 * unrecognized model there (e.g. a non-OpenAI self-hosted endpoint) falls
 * through to `unknown` unless the user configures a manual override.
 */
const CATALOG_PROVIDER_ID: Partial<Record<Provider, string>> = {
  anthropic: "anthropic",
  copilot: "github-copilot",
  codex: "openai",
  "openai-compatible": "openai",
};

/** `openai-compatible` model ids are composite (`<endpoint>/<modelId>`) — only the model half is meaningful to the catalog. */
function catalogLookupModel(provider: Provider, model: string): string {
  if (provider !== "openai-compatible") return model;
  const parsed = parseCompositeModelId(model);
  return parsed ? parsed.modelId : model;
}

function resolveCatalogRates(provider: Provider, model: string): PricingRates | undefined {
  const catalogProviderId = CATALOG_PROVIDER_ID[provider];
  if (!catalogProviderId) return undefined;

  const meta = getModelMeta({
    providers: defaultCatalog,
    provider: catalogProviderId,
    model: catalogLookupModel(provider, model),
  });
  if (!meta?.cost) return undefined;

  return {
    inputPerMTokens: meta.cost.input,
    outputPerMTokens: meta.cost.output,
    cacheReadPerMTokens: meta.cost.cache_read,
    cacheWritePerMTokens: meta.cost.cache_write,
  };
}

/** Manual overrides take priority over the catalog, so a user can correct a stale price or supply one the catalog doesn't have at all. */
function resolveRates(provider: Provider, model: string): PricingRates | undefined {
  const override = readPricingOverrides()[overrideKey(provider, model)];
  return override ?? resolveCatalogRates(provider, model);
}

function usdFromTokens(tokens: number, ratePerMTokens: number | undefined): number {
  return (tokens / 1_000_000) * (ratePerMTokens ?? 0);
}

/**
 * Estimate the USD cost of one usage reading — a single turn (`UsageLedgerRow`)
 * or a pre-aggregated provider+model group (`UsageByProviderModel`, since both
 * shapes carry the same four token fields). Returns `confidence: "unknown"`
 * (all-zero) rather than silently reporting 0 as if it were exact, when no
 * pricing data is available for the given provider/model.
 */
export function estimateCost(params: { provider: Provider; model: string | null; usage: SessionUsage }): CostEstimate {
  const model = params.model?.trim();
  if (!model) return ZERO_COST;

  const rates = resolveRates(params.provider, model);
  if (!rates) return ZERO_COST;

  const inputUSD = usdFromTokens(params.usage.input_tokens, rates.inputPerMTokens);
  const outputUSD = usdFromTokens(params.usage.output_tokens, rates.outputPerMTokens);
  const cacheReadUSD = usdFromTokens(params.usage.cache_read_input_tokens, rates.cacheReadPerMTokens);
  const cacheCreationUSD = usdFromTokens(params.usage.cache_creation_input_tokens, rates.cacheWritePerMTokens);

  return {
    inputUSD,
    outputUSD,
    cacheReadUSD,
    cacheCreationUSD,
    totalUSD: inputUSD + outputUSD + cacheReadUSD + cacheCreationUSD,
    confidence: PARTIAL_FIDELITY_PROVIDERS.has(params.provider) ? "estimated" : "exact",
  };
}
