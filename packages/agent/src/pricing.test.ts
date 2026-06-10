// ---------------------------------------------------------------------------
// Pricing unit tests — pure, no DB, no network.
//
// Pin the $3/MTok-in + $15/MTok-out sonnet-4-6 rates, the documented unknown-
// model fallback, and the 6-decimal persistence formatting used for
// agent_runs.costUsd (numeric(12,6)).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_PRICING,
  MODEL_PRICING,
  computeCostUsd,
  formatCostUsd,
  getModelPricing,
} from "./pricing";

describe("MODEL_PRICING", () => {
  it("prices claude-sonnet-4-6 at $3/MTok input and $15/MTok output", () => {
    expect(MODEL_PRICING["claude-sonnet-4-6"]).toEqual({
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
    });
  });

  it("falls back to the documented default for unknown models", () => {
    expect(getModelPricing("claude-never-heard-of-it")).toEqual(DEFAULT_MODEL_PRICING);
    expect(getModelPricing("claude-sonnet-4-6")).toEqual(
      MODEL_PRICING["claude-sonnet-4-6"],
    );
  });
});

describe("computeCostUsd", () => {
  it("one million tokens each way costs $3 + $15 = $18", () => {
    expect(computeCostUsd("claude-sonnet-4-6", 1_000_000, 1_000_000)).toBe(18);
  });

  it("matches the (in*3 + out*15)/1e6 formula on a realistic run", () => {
    // Flow A's worked example: ~9.4k in / ~0.4k out ≈ $0.034.
    expect(computeCostUsd("claude-sonnet-4-6", 9_400, 400)).toBeCloseTo(0.0342, 10);
    expect(computeCostUsd("claude-sonnet-4-6", 9_400, 400)).toBe(
      (9_400 * 3 + 400 * 15) / 1_000_000,
    );
  });

  it("zero tokens costs zero", () => {
    expect(computeCostUsd("claude-sonnet-4-6", 0, 0)).toBe(0);
  });

  it("unknown models are charged at the default fallback rates", () => {
    expect(computeCostUsd("claude-never-heard-of-it", 1_000_000, 0)).toBe(
      DEFAULT_MODEL_PRICING.inputUsdPerMTok,
    );
  });
});

describe("formatCostUsd", () => {
  it("always renders exactly 6 decimal places for numeric(12,6) persistence", () => {
    expect(formatCostUsd(0.0342)).toBe("0.034200");
    expect(formatCostUsd(0)).toBe("0.000000");
    expect(formatCostUsd(18)).toBe("18.000000");
  });

  it("rounds beyond-6dp values instead of truncating digits arbitrarily", () => {
    expect(formatCostUsd(0.0000014999)).toBe("0.000001");
    expect(formatCostUsd(0.0000025)).toBe("0.000003");
  });

  it("round-trips a computed cost through the persisted string shape", () => {
    const cost = computeCostUsd("claude-sonnet-4-6", 9_400, 400);
    expect(formatCostUsd(cost)).toBe("0.034200");
    expect(Number(formatCostUsd(cost))).toBeCloseTo(cost, 6);
  });
});
