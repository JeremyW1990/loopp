// ---------------------------------------------------------------------------
// Model pricing — USD per million tokens.
//
// costUsd is the single floating-point money value in the system: refund
// amounts are integer cents everywhere, and the cost float is converted to a
// fixed 6-decimal string (formatCostUsd) only at the persistence edge, where
// trace.ts writes agent_runs.costUsd into numeric(12,6).
// ---------------------------------------------------------------------------

export interface ModelPricing {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
}

/**
 * Per-model rates. claude-sonnet-4-6: $3/MTok input, $15/MTok output
 * (current Anthropic list pricing, verified 2026-06).
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-sonnet-4-6": { inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
};

/**
 * Fallback for model ids missing from MODEL_PRICING (e.g. an ANTHROPIC_MODEL
 * override we haven't priced): sonnet-4-6 rates, so costUsd stays a sane
 * estimate instead of silently reporting $0. Add a MODEL_PRICING entry when
 * running a different model in earnest.
 */
export const DEFAULT_MODEL_PRICING: ModelPricing = {
  inputUsdPerMTok: 3,
  outputUsdPerMTok: 15,
};

export function getModelPricing(model: string): ModelPricing {
  return MODEL_PRICING[model] ?? DEFAULT_MODEL_PRICING;
}

/** Run cost in USD for the given token totals (summed over all attempts). */
export function computeCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = getModelPricing(model);
  return (
    (inputTokens * pricing.inputUsdPerMTok + outputTokens * pricing.outputUsdPerMTok) /
    1_000_000
  );
}

/**
 * The exact string persisted into agent_runs.costUsd (numeric(12,6)) —
 * always 6 decimal places, the only place the cost float meets storage.
 */
export function formatCostUsd(costUsd: number): string {
  return costUsd.toFixed(6);
}
