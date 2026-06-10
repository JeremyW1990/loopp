// ---------------------------------------------------------------------------
// Exhaustive boundary tests for the pure eligibility engine.
//
// Pure unit tests: no database, no network, no environment, no API key. Time
// is the frozen NOW constant and every delivery instant is an exact
// millisecond offset from it — mirroring how packages/db/src/seed-data.ts
// resolves its "daysAgo" fields — so the 29/30/31-day boundaries can never
// flake on wall-clock, timezone, or DST drift.
//
// Fixtures named ord_* mirror the seed orders of the same id (same prices,
// quantities, final-sale flags, delivery offsets); synthetic ord_synth_*
// fixtures pin the exact boundaries the seed does not cover.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  checkRefundEligibility,
  type DenyRuleId,
  type EligibilityInput,
  type EligibilityItem,
  type EligibilityOrder,
  type EligibilityResult,
  type PriorRefundStatus,
} from "./eligibility";
import { POLICY_RULES, UNKNOWN_ITEM, type PolicyRule } from "./rules";

/** Frozen clock for every test — the engine never reads real time. */
const NOW = new Date("2026-06-09T12:00:00Z");

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Delivery instant exactly `days` days (in ms) before NOW. */
function deliveredDaysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function delivered(
  id: string,
  daysAgo: number,
  shippingCents: number,
): EligibilityOrder {
  return {
    id,
    status: "delivered",
    deliveredAt: deliveredDaysAgo(daysAgo),
    shippingCents,
  };
}

function undelivered(
  id: string,
  status: "processing" | "shipped" | "cancelled",
): EligibilityOrder {
  return { id, status, deliveredAt: null, shippingCents: 0 };
}

function item(
  id: string,
  unitPriceCents: number,
  opts: { quantity?: number; isFinalSale?: boolean } = {},
): EligibilityItem {
  return {
    id,
    unitPriceCents,
    quantity: opts.quantity ?? 1,
    isFinalSale: opts.isFinalSale ?? false,
  };
}

function verdictFor(result: EligibilityResult, itemId: string) {
  const verdict = result.verdicts.find((v) => v.itemId === itemId);
  if (!verdict) throw new Error(`expected a verdict for ${itemId}`);
  return verdict;
}

function expectAllow(result: EligibilityResult, itemId: string): void {
  const verdict = verdictFor(result, itemId);
  expect(verdict).toMatchObject({ itemId, eligible: true });
  // Eligible verdicts carry no ruleId at all (not even an undefined one).
  expect("ruleId" in verdict).toBe(false);
}

function expectDeny(
  result: EligibilityResult,
  itemId: string,
  ruleId: DenyRuleId,
): void {
  expect(verdictFor(result, itemId)).toMatchObject({
    itemId,
    eligible: false,
    ruleId,
  });
}

/**
 * POLICY_RULES with windowDays / thresholdCents overridden — used to prove
 * the engine reads its parameters from the passed rule data (single-source
 * invariant), not from constants of its own.
 */
function ruleSet(overrides: {
  windowDays?: number;
  thresholdCents?: number;
}): PolicyRule[] {
  return POLICY_RULES.map((rule): PolicyRule => {
    if (rule.id === "return_window" && overrides.windowDays !== undefined) {
      return { ...rule, params: { windowDays: overrides.windowDays } };
    }
    if (
      rule.id === "escalation_threshold" &&
      overrides.thresholdCents !== undefined
    ) {
      return { ...rule, params: { thresholdCents: overrides.thresholdCents } };
    }
    return rule;
  });
}

// --- Fixtures mirroring packages/db/src/seed-data.ts ------------------------

/** ord_1001 — Maya Chen's happy path: pour-over set + linen pillows x2. */
const ORD_1001: EligibilityInput = {
  order: delivered("ord_1001", 6, 799),
  items: [item("itm_1001_1", 5999), item("itm_1001_2", 3499, { quantity: 2 })],
  priorRefunds: [],
};

/** ord_1003 — mixed cart: final-sale silk dress + regular leather boots. */
const ORD_1003: EligibilityInput = {
  order: delivered("ord_1003", 8, 599),
  items: [
    item("itm_1003_1", 18999, { isFinalSale: true }),
    item("itm_1003_2", 14999),
  ],
  priorRefunds: [],
};

/** ord_1009 — Priya's headphones, already covered by a prior refund. */
function ord1009With(status: PriorRefundStatus): EligibilityInput {
  return {
    order: delivered("ord_1009", 25, 0),
    items: [item("itm_1009_1", 27999)],
    priorRefunds: [{ itemIds: ["itm_1009_1"], status }],
  };
}

/** ord_1012 — Marcus's keyboard, shipped but not delivered. */
const ORD_1012: EligibilityInput = {
  order: undelivered("ord_1012", "shipped"),
  items: [item("itm_1012_1", 12900)],
  priorRefunds: [],
};

/** ord_1015 — Sofia's cancelled handbag order. */
const ORD_1015: EligibilityInput = {
  order: undelivered("ord_1015", "cancelled"),
  items: [item("itm_1015_1", 22000)],
  priorRefunds: [],
};

/** ord_1016 — Sofia's clearance sunglasses: the whole cart is final sale. */
const ORD_1016: EligibilityInput = {
  order: delivered("ord_1016", 2, 499),
  items: [item("itm_1016_1", 9500, { isFinalSale: true })],
  priorRefunds: [],
};

/** ord_1020 — Emma's table runner, delivered 31 days ago (just outside). */
const ORD_1020: EligibilityInput = {
  order: delivered("ord_1020", 31, 399),
  items: [item("itm_1020_1", 2800)],
  priorRefunds: [],
};

/** ord_1021 — Emma's throw blanket, delivered 29 days ago (just inside). */
const ORD_1021: EligibilityInput = {
  order: delivered("ord_1021", 29, 499),
  items: [item("itm_1021_1", 5499)],
  priorRefunds: [],
};

/** ord_1022 — Noah's office chair: exactly $500.00. */
const ORD_1022: EligibilityInput = {
  order: delivered("ord_1022", 9, 0),
  items: [item("itm_1022_1", 50000)],
  priorRefunds: [],
};

/** ord_1023 — Noah's standing desk: $525.00, over the threshold. */
const ORD_1023: EligibilityInput = {
  order: delivered("ord_1023", 11, 0),
  items: [item("itm_1023_1", 52500)],
  priorRefunds: [],
};

/** ord_1028 — Isabella's $1,200 order: espresso machine + burr grinder. */
const ORD_1028: EligibilityInput = {
  order: delivered("ord_1028", 5, 0),
  items: [item("itm_1028_1", 74900), item("itm_1028_2", 45100)],
  priorRefunds: [],
};

/** ord_1030 — Ethan's 3-item cart with a final-sale camp stove. */
const ORD_1030: EligibilityInput = {
  order: delivered("ord_1030", 6, 899),
  items: [
    item("itm_1030_1", 15999),
    item("itm_1030_2", 18999),
    item("itm_1030_3", 7999, { isFinalSale: true }),
  ],
  priorRefunds: [],
};

/** ord_1033 — Charlotte's reading chair, still processing. */
const ORD_1033: EligibilityInput = {
  order: undelivered("ord_1033", "processing"),
  items: [item("itm_1033_1", 38900)],
  priorRefunds: [],
};

/** ord_1034 — Mohammed's bedding set with $12.99 shipping (excluded). */
const ORD_1034: EligibilityInput = {
  order: delivered("ord_1034", 10, 1299),
  items: [item("itm_1034_1", 13499)],
  priorRefunds: [],
};

// --- Tests -------------------------------------------------------------------

describe("checkRefundEligibility", () => {
  describe("happy path", () => {
    it("ord_1001 mirror: delivered cart fully eligible with quantity x2 -> refundableCents 12997", () => {
      const result = checkRefundEligibility(
        ORD_1001,
        ["itm_1001_1", "itm_1001_2"],
        NOW,
      );
      expectAllow(result, "itm_1001_1");
      expectAllow(result, "itm_1001_2");
      expect(result.verdicts).toHaveLength(2);
      expect(result.refundableCents).toBe(12997); // 5999x1 + 3499x2
      expect(result.requiresEscalation).toBe(false);
    });
  });

  describe("return window boundaries (inclusive 30 days, floor day counting)", () => {
    it("ord_1021 mirror: 29 days since delivery is inside the window", () => {
      const result = checkRefundEligibility(ORD_1021, ["itm_1021_1"], NOW);
      expectAllow(result, "itm_1021_1");
      expect(verdictFor(result, "itm_1021_1").reason).toContain("29 days");
      expect(result.refundableCents).toBe(5499);
    });

    it("ord_1036 mirror: delivered today (0 days) is eligible", () => {
      const input: EligibilityInput = {
        order: delivered("ord_1036", 0, 399),
        items: [item("itm_1036_1", 3999)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_1036_1"], NOW);
      expectAllow(result, "itm_1036_1");
      expect(result.refundableCents).toBe(3999);
    });

    it("boundary: exactly 30 days since delivery is still eligible", () => {
      const input: EligibilityInput = {
        order: delivered("ord_synth_30d", 30, 0),
        items: [item("itm_synth_30d", 4500)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_synth_30d"], NOW);
      expectAllow(result, "itm_synth_30d");
      expect(result.refundableCents).toBe(4500);
    });

    it("boundary: 30 days plus 12 hours floors to day 30 and stays eligible", () => {
      // daysBetween floors ms/86_400_000: partial days round DOWN, so a
      // delivery 30.5 days ago is still day 30 — a later "calendar days"
      // reinterpretation of the window must fail this pin.
      const input: EligibilityInput = {
        order: {
          id: "ord_synth_30d12h",
          status: "delivered",
          deliveredAt: new Date(NOW.getTime() - 30 * DAY_MS - 12 * HOUR_MS),
          shippingCents: 0,
        },
        items: [item("itm_synth_30d12h", 4500)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_synth_30d12h"], NOW);
      expectAllow(result, "itm_synth_30d12h");
    });

    it("ord_1020 mirror: 31 days since delivery is denied citing return_window", () => {
      const result = checkRefundEligibility(ORD_1020, ["itm_1020_1"], NOW);
      expectDeny(result, "itm_1020_1", "return_window");
      const reason = verdictFor(result, "itm_1020_1").reason;
      expect(reason).toContain("31 days");
      expect(reason).toContain("30-day"); // window size interpolated from rule data
      expect(result.refundableCents).toBe(0);
    });
  });

  describe("escalation threshold (strictly over 50000 cents)", () => {
    it("ord_1022 mirror: exactly 50000 refundable cents does not escalate", () => {
      const result = checkRefundEligibility(ORD_1022, ["itm_1022_1"], NOW);
      expectAllow(result, "itm_1022_1");
      expect(result.refundableCents).toBe(50000);
      expect(result.requiresEscalation).toBe(false); // exactly $500.00 processes
    });

    it("boundary: 50001 refundable cents requires escalation", () => {
      const input: EligibilityInput = {
        order: delivered("ord_synth_50001", 5, 0),
        items: [item("itm_synth_50001", 50001)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_synth_50001"], NOW);
      expect(result.refundableCents).toBe(50001);
      expect(result.requiresEscalation).toBe(true);
    });

    it("ord_1023 mirror: 52500 refundable cents requires escalation", () => {
      const result = checkRefundEligibility(ORD_1023, ["itm_1023_1"], NOW);
      expect(result.refundableCents).toBe(52500);
      expect(result.requiresEscalation).toBe(true);
    });

    it("ord_1028 mirror: grinder-only request of 45100 does not escalate", () => {
      // Escalation is scoped to the REQUESTED amount, not the order total.
      const result = checkRefundEligibility(ORD_1028, ["itm_1028_2"], NOW);
      expect(result.verdicts).toHaveLength(1);
      expect(result.refundableCents).toBe(45100);
      expect(result.requiresEscalation).toBe(false);
    });

    it("ord_1028 mirror: requesting both items totals 120000 and escalates", () => {
      const result = checkRefundEligibility(
        ORD_1028,
        ["itm_1028_1", "itm_1028_2"],
        NOW,
      );
      expect(result.refundableCents).toBe(120000);
      expect(result.requiresEscalation).toBe(true);
    });
  });

  describe("partial refunds (carts judged per item)", () => {
    it("ord_1003 mirror: boots refund while the final-sale dress is denied -> refundableCents 14999", () => {
      const result = checkRefundEligibility(
        ORD_1003,
        ["itm_1003_1", "itm_1003_2"],
        NOW,
      );
      expectDeny(result, "itm_1003_1", "final_sale");
      expectAllow(result, "itm_1003_2");
      expect(result.refundableCents).toBe(14999);
      expect(result.requiresEscalation).toBe(false);
    });

    it("ord_1030 mirror: jacket and boots refund while the final-sale stove is denied -> refundableCents 34998", () => {
      const result = checkRefundEligibility(
        ORD_1030,
        ["itm_1030_1", "itm_1030_2", "itm_1030_3"],
        NOW,
      );
      expectAllow(result, "itm_1030_1");
      expectAllow(result, "itm_1030_2");
      expectDeny(result, "itm_1030_3", "final_sale");
      expect(result.refundableCents).toBe(34998); // 15999 + 18999, stove excluded
    });

    it("ord_1016 mirror: an all-final-sale cart refunds nothing -> refundableCents 0", () => {
      const result = checkRefundEligibility(ORD_1016, ["itm_1016_1"], NOW);
      expectDeny(result, "itm_1016_1", "final_sale");
      expect(result.refundableCents).toBe(0);
      expect(result.requiresEscalation).toBe(false);
    });
  });

  describe("no double refund (prior refund locks)", () => {
    it("ord_1009 mirror: a processed prior refund denies the item citing no_double_refund", () => {
      const result = checkRefundEligibility(
        ord1009With("processed"),
        ["itm_1009_1"],
        NOW,
      );
      expectDeny(result, "itm_1009_1", "no_double_refund");
      expect(result.refundableCents).toBe(0);
    });

    it("ord_1009 variant: an escalated prior refund blocks re-refunding", () => {
      // An open escalation must lock the item — approving it later would
      // otherwise pay the same item out twice.
      const result = checkRefundEligibility(
        ord1009With("escalated"),
        ["itm_1009_1"],
        NOW,
      );
      expectDeny(result, "itm_1009_1", "no_double_refund");
    });

    it("ord_1009 variant: an approved prior refund blocks re-refunding", () => {
      const result = checkRefundEligibility(
        ord1009With("approved"),
        ["itm_1009_1"],
        NOW,
      );
      expectDeny(result, "itm_1009_1", "no_double_refund");
    });

    it("ord_1009 variant: a rejected prior refund does not block re-refunding", () => {
      const result = checkRefundEligibility(
        ord1009With("rejected"),
        ["itm_1009_1"],
        NOW,
      );
      expectAllow(result, "itm_1009_1");
      expect(result.refundableCents).toBe(27999);
    });
  });

  describe("delivered orders only", () => {
    it("ord_1012 mirror: shipped order is denied citing delivered_only", () => {
      const result = checkRefundEligibility(ORD_1012, ["itm_1012_1"], NOW);
      expectDeny(result, "itm_1012_1", "delivered_only");
      expect(verdictFor(result, "itm_1012_1").reason).toContain("shipped");
      expect(result.refundableCents).toBe(0);
    });

    it("ord_1033 mirror: processing order is denied citing delivered_only", () => {
      const result = checkRefundEligibility(ORD_1033, ["itm_1033_1"], NOW);
      expectDeny(result, "itm_1033_1", "delivered_only");
      expect(result.refundableCents).toBe(0);
    });

    it("ord_1015 mirror: cancelled order is denied citing delivered_only", () => {
      const result = checkRefundEligibility(ORD_1015, ["itm_1015_1"], NOW);
      expectDeny(result, "itm_1015_1", "delivered_only");
      expect(result.refundableCents).toBe(0);
    });

    it("defensive: delivered status with a null deliveredAt is denied citing delivered_only", () => {
      const input: EligibilityInput = {
        order: {
          id: "ord_synth_nullts",
          status: "delivered",
          deliveredAt: null,
          shippingCents: 0,
        },
        items: [item("itm_synth_nullts", 1999)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_synth_nullts"], NOW);
      expectDeny(result, "itm_synth_nullts", "delivered_only");
      expect(verdictFor(result, "itm_synth_nullts").reason).toContain(
        "no delivery date",
      );
    });
  });

  describe("shipping is never refundable", () => {
    it("ord_1034 mirror: the item subtotal 13499 is fully refundable", () => {
      const result = checkRefundEligibility(ORD_1034, ["itm_1034_1"], NOW);
      expectAllow(result, "itm_1034_1");
      expect(result.refundableCents).toBe(13499);
    });

    it("ord_1034 mirror: shipping 1299 is never added -> refundableCents 13499, not 14798", () => {
      const result = checkRefundEligibility(ORD_1034, ["itm_1034_1"], NOW);
      expect(result.refundableCents).toBe(13499);
      expect(result.refundableCents).not.toBe(14798); // 13499 + 1299 shipping
    });
  });

  describe("request hygiene and guardrails", () => {
    it("unknown item ids are denied with the unknown_item guardrail", () => {
      const result = checkRefundEligibility(ORD_1001, ["itm_9999_bogus"], NOW);
      expectDeny(result, "itm_9999_bogus", UNKNOWN_ITEM);
      expect(result.refundableCents).toBe(0);
      expect(result.requiresEscalation).toBe(false);
    });

    it("a foreign item id alongside a valid one denies only the foreign id", () => {
      // itm_1003_1 belongs to ord_1003, not ord_1001.
      const result = checkRefundEligibility(
        ORD_1001,
        ["itm_1001_1", "itm_1003_1"],
        NOW,
      );
      expectAllow(result, "itm_1001_1");
      expectDeny(result, "itm_1003_1", UNKNOWN_ITEM);
      expect(result.refundableCents).toBe(5999);
    });

    it("duplicate requested ids collapse to a single verdict counted once", () => {
      const result = checkRefundEligibility(
        ORD_1001,
        ["itm_1001_2", "itm_1001_2", "itm_1001_2"],
        NOW,
      );
      expect(result.verdicts).toHaveLength(1);
      expect(result.refundableCents).toBe(6998); // 3499 x 2, counted exactly once
    });

    it("verdicts come back one per unique id in first-seen request order", () => {
      const result = checkRefundEligibility(
        ORD_1001,
        ["itm_1001_2", "itm_1001_1", "itm_1001_2"],
        NOW,
      );
      expect(result.verdicts.map((v) => v.itemId)).toEqual([
        "itm_1001_2",
        "itm_1001_1",
      ]);
      expect(result.refundableCents).toBe(12997); // each item counted exactly once
    });

    it("an empty request yields no verdicts, zero cents, and no escalation", () => {
      const result = checkRefundEligibility(ORD_1001, [], NOW);
      expect(result).toEqual({
        verdicts: [],
        refundableCents: 0,
        requiresEscalation: false,
      });
    });
  });

  describe("deny precedence (first failing check wins)", () => {
    it("precedence: a final-sale item on a shipped order cites delivered_only", () => {
      const input: EligibilityInput = {
        order: undelivered("ord_synth_prec1", "shipped"),
        items: [item("itm_synth_prec1", 9999, { isFinalSale: true })],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_synth_prec1"], NOW);
      expectDeny(result, "itm_synth_prec1", "delivered_only");
    });

    it("precedence: a final-sale item that was already refunded cites final_sale", () => {
      const input: EligibilityInput = {
        order: delivered("ord_synth_prec2", 5, 0),
        items: [item("itm_synth_prec2", 9999, { isFinalSale: true })],
        priorRefunds: [{ itemIds: ["itm_synth_prec2"], status: "processed" }],
      };
      const result = checkRefundEligibility(input, ["itm_synth_prec2"], NOW);
      expectDeny(result, "itm_synth_prec2", "final_sale");
    });

    it("precedence: an unknown id on an undelivered order still cites unknown_item", () => {
      const input: EligibilityInput = {
        order: undelivered("ord_synth_prec3", "processing"),
        items: [item("itm_synth_prec3", 1500)],
        priorRefunds: [],
      };
      const result = checkRefundEligibility(input, ["itm_bogus"], NOW);
      expectDeny(result, "itm_bogus", UNKNOWN_ITEM);
    });
  });

  describe("single-source proof: behavior follows injected rule data", () => {
    it("injected windowDays 14 flips a 20-day-old delivery from eligible to denied", () => {
      const input: EligibilityInput = {
        order: delivered("ord_synth_inject1", 20, 0),
        items: [item("itm_synth_inject1", 4500)],
        priorRefunds: [],
      };
      const withDefaults = checkRefundEligibility(
        input,
        ["itm_synth_inject1"],
        NOW,
      );
      expectAllow(withDefaults, "itm_synth_inject1");

      const narrowed = checkRefundEligibility(
        input,
        ["itm_synth_inject1"],
        NOW,
        ruleSet({ windowDays: 14 }),
      );
      expectDeny(narrowed, "itm_synth_inject1", "return_window");
      expect(verdictFor(narrowed, "itm_synth_inject1").reason).toContain(
        "14-day",
      );
    });

    it("injected thresholdCents 10000 flips ord_1034 from processing to escalation", () => {
      const withDefaults = checkRefundEligibility(ORD_1034, ["itm_1034_1"], NOW);
      expect(withDefaults.requiresEscalation).toBe(false);

      const lowered = checkRefundEligibility(
        ORD_1034,
        ["itm_1034_1"],
        NOW,
        ruleSet({ thresholdCents: 10000 }),
      );
      expect(lowered.refundableCents).toBe(13499);
      expect(lowered.requiresEscalation).toBe(true);
    });
  });

  describe("determinism and purity", () => {
    it("identical calls return deeply equal results", () => {
      const run = () =>
        checkRefundEligibility(
          ORD_1003,
          ["itm_1003_1", "itm_1003_2", "itm_bogus"],
          NOW,
        );
      expect(run()).toEqual(run());
    });

    it("does not mutate its inputs", () => {
      const input: EligibilityInput = {
        order: delivered("ord_synth_mut", 5, 499),
        items: [item("itm_synth_mut", 1000)],
        priorRefunds: [{ itemIds: ["itm_synth_mut"], status: "rejected" }],
      };
      const requested = ["itm_synth_mut", "itm_synth_mut"];
      const inputSnapshot = structuredClone(input);
      const requestedSnapshot = [...requested];

      checkRefundEligibility(input, requested, NOW);

      expect(input).toEqual(inputSnapshot);
      expect(requested).toEqual(requestedSnapshot);
    });
  });
});
