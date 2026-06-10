// ---------------------------------------------------------------------------
// Policy-data sanity checks and the rule-coverage meta-test.
//
// RULE_COVERAGE maps every customer-facing rule id to the named tests that
// prove BOTH sides of the rule (at least one allow and one deny). The
// meta-test iterates the runtime POLICY_RULES array, so adding a 9th rule
// fails this suite until the new rule ships with tests — and the `satisfies
// Record<PolicyRuleId, ...>` constraint breaks typecheck at the same moment.
// A second meta-test verifies every cited name exists verbatim in
// eligibility.test.ts or render.test.ts, so the matrix cannot drift into
// citing tests that were renamed or deleted.
//
// This file imports from "./index" deliberately: it doubles as a pin on the
// public surface T3 consumers (agent tools) will import.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  POLICY_RULES,
  UNKNOWN_ITEM,
  getThresholdCents,
  getWindowDays,
  type PolicyRuleId,
} from "./index";

describe("POLICY_RULES data sanity", () => {
  it("contains exactly the 8 policy rules with unique ids", () => {
    expect(POLICY_RULES).toHaveLength(8);
    const ids = POLICY_RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([
      "delivered_only",
      "escalation_threshold",
      "final_sale",
      "no_double_refund",
      "original_payment_method",
      "partial_refunds",
      "return_window",
      "shipping_non_refundable",
    ]);
  });

  it("return window is 30 days, read through the typed accessor", () => {
    expect(getWindowDays(POLICY_RULES)).toBe(30);
    expect(getWindowDays()).toBe(30); // default argument is POLICY_RULES
  });

  it("escalation threshold is 50000 cents, read through the typed accessor", () => {
    expect(getThresholdCents(POLICY_RULES)).toBe(50000);
    expect(getThresholdCents()).toBe(50000);
  });

  it("every rule has a non-empty title and summary", () => {
    for (const rule of POLICY_RULES) {
      expect(rule.title.trim().length, `rule "${rule.id}" title`).toBeGreaterThan(0);
      expect(rule.summary.trim().length, `rule "${rule.id}" summary`).toBeGreaterThan(0);
    }
  });

  it("all rule params are integers (money is integer cents, never floats)", () => {
    for (const rule of POLICY_RULES) {
      for (const [key, value] of Object.entries(rule.params)) {
        expect(Number.isInteger(value), `rule "${rule.id}" param "${key}"`).toBe(true);
      }
    }
  });

  it("every machine param is surfaced as a {placeholder} in its rule summary", () => {
    // Single-source visibility: a param the customer never sees in the doc
    // would let the engine and the document drift apart silently.
    for (const rule of POLICY_RULES) {
      for (const key of Object.keys(rule.params)) {
        expect(rule.summary, `rule "${rule.id}" must surface {${key}}`).toContain(`{${key}}`);
      }
    }
  });

  it("every {placeholder} in a summary matches a param key", () => {
    for (const rule of POLICY_RULES) {
      for (const match of rule.summary.matchAll(/\{(\w+)\}/g)) {
        expect(
          Object.keys(rule.params),
          `rule "${rule.id}" placeholder {${match[1]}} has no matching param`,
        ).toContain(match[1]);
      }
    }
  });

  it("unknown_item is a reserved guardrail id, not a customer-facing rule", () => {
    expect(UNKNOWN_ITEM).toBe("unknown_item");
    expect(POLICY_RULES.some((rule) => (rule.id as string) === UNKNOWN_ITEM)).toBe(false);
  });
});

// --- Rule-coverage matrix ----------------------------------------------------

interface RuleCoverage {
  /** Tests proving the rule LETS a refund through (or its wording renders). */
  readonly allow: readonly string[];
  /** Tests proving the rule BLOCKS a refund (or its wording disappears). */
  readonly deny: readonly string[];
}

/**
 * Named allow + deny tests per rule id. Names must match `it(...)` titles in
 * eligibility.test.ts / render.test.ts verbatim (a meta-test below enforces
 * this). Mixed-cart tests legitimately appear on both sides when a single
 * cart asserts an allowed item next to a denied one.
 */
const RULE_COVERAGE = {
  return_window: {
    allow: [
      "ord_1021 mirror: 29 days since delivery is inside the window",
      "boundary: exactly 30 days since delivery is still eligible",
      "boundary: 30 days plus 12 hours floors to day 30 and stays eligible",
    ],
    deny: [
      "ord_1020 mirror: 31 days since delivery is denied citing return_window",
      "injected windowDays 14 flips a 20-day-old delivery from eligible to denied",
    ],
  },
  delivered_only: {
    allow: [
      "ord_1001 mirror: delivered cart fully eligible with quantity x2 -> refundableCents 12997",
    ],
    deny: [
      "ord_1012 mirror: shipped order is denied citing delivered_only",
      "ord_1033 mirror: processing order is denied citing delivered_only",
      "ord_1015 mirror: cancelled order is denied citing delivered_only",
      "defensive: delivered status with a null deliveredAt is denied citing delivered_only",
      "precedence: a final-sale item on a shipped order cites delivered_only",
    ],
  },
  final_sale: {
    allow: [
      // The boots in the same cart pass the final-sale check while the dress fails it.
      "ord_1003 mirror: boots refund while the final-sale dress is denied -> refundableCents 14999",
    ],
    deny: [
      "ord_1003 mirror: boots refund while the final-sale dress is denied -> refundableCents 14999",
      "ord_1016 mirror: an all-final-sale cart refunds nothing -> refundableCents 0",
      "precedence: a final-sale item that was already refunded cites final_sale",
    ],
  },
  partial_refunds: {
    allow: [
      "ord_1003 mirror: boots refund while the final-sale dress is denied -> refundableCents 14999",
      "ord_1030 mirror: jacket and boots refund while the final-sale stove is denied -> refundableCents 34998",
      "policy doc states refunds are assessed per item",
    ],
    deny: [
      "ord_1016 mirror: an all-final-sale cart refunds nothing -> refundableCents 0",
      "filtering out partial_refunds removes its wording from the doc",
    ],
  },
  shipping_non_refundable: {
    allow: [
      "ord_1034 mirror: the item subtotal 13499 is fully refundable",
    ],
    deny: [
      "ord_1034 mirror: shipping 1299 is never added -> refundableCents 13499, not 14798",
    ],
  },
  no_double_refund: {
    allow: [
      "ord_1009 variant: a rejected prior refund does not block re-refunding",
    ],
    deny: [
      "ord_1009 mirror: a processed prior refund denies the item citing no_double_refund",
      "ord_1009 variant: an escalated prior refund blocks re-refunding",
      "ord_1009 variant: an approved prior refund blocks re-refunding",
    ],
  },
  escalation_threshold: {
    allow: [
      "ord_1022 mirror: exactly 50000 refundable cents does not escalate",
      "ord_1028 mirror: grinder-only request of 45100 does not escalate",
    ],
    deny: [
      "boundary: 50001 refundable cents requires escalation",
      "ord_1023 mirror: 52500 refundable cents requires escalation",
      "ord_1028 mirror: requesting both items totals 120000 and escalates",
      "injected thresholdCents 10000 flips ord_1034 from processing to escalation",
    ],
  },
  original_payment_method: {
    allow: [
      "policy doc states refunds go to the original payment method",
    ],
    deny: [
      "filtering out original_payment_method removes its wording from the doc",
    ],
  },
} as const satisfies Record<PolicyRuleId, RuleCoverage>;

/**
 * The unknown_item guardrail is deny-only by design: it exists to refuse
 * foreign/unknown item ids, so there is nothing to "allow".
 */
const GUARDRAIL_COVERAGE = {
  [UNKNOWN_ITEM]: {
    deny: [
      "unknown item ids are denied with the unknown_item guardrail",
      "a foreign item id alongside a valid one denies only the foreign id",
      "precedence: an unknown id on an undelivered order still cites unknown_item",
    ],
  },
} as const satisfies Record<typeof UNKNOWN_ITEM, { readonly deny: readonly string[] }>;

describe("rule coverage meta-test", () => {
  it("every rule in POLICY_RULES has at least one allow and one deny test", () => {
    for (const rule of POLICY_RULES) {
      const coverage: RuleCoverage | undefined = RULE_COVERAGE[rule.id];
      if (coverage === undefined) {
        throw new Error(
          `POLICY_RULES contains "${rule.id}" but RULE_COVERAGE has no entry — ` +
            `ship the new rule with at least one allow and one deny test`,
        );
      }
      expect(
        coverage.allow.length,
        `rule "${rule.id}" needs at least one allow test`,
      ).toBeGreaterThanOrEqual(1);
      expect(
        coverage.deny.length,
        `rule "${rule.id}" needs at least one deny test`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("the unknown_item guardrail is registered deny-only", () => {
    expect(GUARDRAIL_COVERAGE[UNKNOWN_ITEM].deny.length).toBeGreaterThanOrEqual(1);
    expect("allow" in GUARDRAIL_COVERAGE[UNKNOWN_ITEM]).toBe(false);
  });

  it("every cited test name exists verbatim in eligibility.test.ts or render.test.ts", () => {
    const source =
      readFileSync(new URL("./eligibility.test.ts", import.meta.url), "utf8") +
      readFileSync(new URL("./render.test.ts", import.meta.url), "utf8");
    const citedNames = new Set<string>([
      ...Object.values(RULE_COVERAGE).flatMap((coverage) => [
        ...coverage.allow,
        ...coverage.deny,
      ]),
      ...GUARDRAIL_COVERAGE[UNKNOWN_ITEM].deny,
    ]);
    for (const name of citedNames) {
      expect(
        source.includes(`"${name}"`),
        `cited test "${name}" was not found — keep RULE_COVERAGE in sync with real test names`,
      ).toBe(true);
    }
  });
});
