// ---------------------------------------------------------------------------
// Refund policy — the single source of truth.
//
// Every rule lives ONCE, here, as typed data carrying both the machine
// parameters the eligibility engine reads (windowDays, thresholdCents) and
// the customer-facing wording the policy document renders. The committed
// docs/refund-policy.md and checkRefundEligibility() both derive from this
// array — never hand-edit the rendered doc, and never duplicate the numeric
// literals below anywhere else (eligibility.ts and render.ts must read them
// through the typed accessors at the bottom of this file).
// ---------------------------------------------------------------------------

/** Identifiers of the customer-facing policy rules, in no particular order. */
export type PolicyRuleId =
  | "return_window"
  | "delivered_only"
  | "final_sale"
  | "partial_refunds"
  | "shipping_non_refundable"
  | "no_double_refund"
  | "escalation_threshold"
  | "original_payment_method";

interface RuleShape<
  Id extends PolicyRuleId,
  Params extends Readonly<Record<string, number>> = Record<string, never>,
> {
  readonly id: Id;
  /** Short heading used as the section title in the rendered policy doc. */
  readonly title: string;
  /**
   * Customer-facing wording. `{param}` placeholders (named after keys of
   * `params`) are interpolated by the renderer, so the numbers never live
   * in prose — changing `params` changes the rendered document.
   */
  readonly summary: string;
  /** Machine-readable parameters the eligibility engine reads. */
  readonly params: Params;
}

export type ReturnWindowRule = RuleShape<
  "return_window",
  { readonly windowDays: number }
>;
export type DeliveredOnlyRule = RuleShape<"delivered_only">;
export type FinalSaleRule = RuleShape<"final_sale">;
export type PartialRefundsRule = RuleShape<"partial_refunds">;
export type ShippingNonRefundableRule = RuleShape<"shipping_non_refundable">;
export type NoDoubleRefundRule = RuleShape<"no_double_refund">;
export type EscalationThresholdRule = RuleShape<
  "escalation_threshold",
  { readonly thresholdCents: number }
>;
export type OriginalPaymentMethodRule = RuleShape<"original_payment_method">;

/** A single refund-policy rule, discriminated on `id`. */
export type PolicyRule =
  | ReturnWindowRule
  | DeliveredOnlyRule
  | FinalSaleRule
  | PartialRefundsRule
  | ShippingNonRefundableRule
  | NoDoubleRefundRule
  | EscalationThresholdRule
  | OriginalPaymentMethodRule;

/**
 * The corporate refund policy. Array order is the section order of the
 * rendered document, so it reads top-to-bottom as a coherent policy.
 *
 * Eligibility semantics (implemented in eligibility.ts):
 *   - eligible iff days since delivery <= windowDays (day 30 still passes)
 *   - escalate iff refundable cents > thresholdCents (exactly $500 processes)
 */
export const POLICY_RULES: readonly PolicyRule[] = [
  {
    id: "return_window",
    title: "Return window",
    summary:
      "Items are eligible for a refund for {windowDays} days after delivery. Requests made after the window closes are declined.",
    params: { windowDays: 30 },
  },
  {
    id: "delivered_only",
    title: "Delivered orders only",
    summary:
      "Refunds are only issued for orders that have been delivered. Orders still processing, in transit, or cancelled are not eligible.",
    params: {},
  },
  {
    id: "final_sale",
    title: "Final-sale items",
    summary: "Items marked as final sale are not eligible for a refund.",
    params: {},
  },
  {
    id: "partial_refunds",
    title: "Partial refunds",
    summary:
      "Refunds are assessed per item. Eligible items in an order are refunded even when other items in the same order do not qualify.",
    params: {},
  },
  {
    id: "shipping_non_refundable",
    title: "Shipping charges",
    summary:
      "Shipping charges are non-refundable. Refunds cover the purchase price of eligible items only.",
    params: {},
  },
  {
    id: "no_double_refund",
    title: "One refund per item",
    summary:
      "An item can be refunded only once. Items already covered by a processed refund or an open escalation cannot be refunded again.",
    params: {},
  },
  {
    id: "escalation_threshold",
    title: "High-value refund review",
    summary:
      "Refunds totaling more than {thresholdCents} are escalated to a human specialist for review before any money is paid out.",
    params: { thresholdCents: 50000 },
  },
  {
    id: "original_payment_method",
    title: "Original payment method",
    summary:
      "Refunds are always issued to the original payment method used for the order — never to a different card, account, or store credit.",
    params: {},
  },
];

/**
 * Reserved verdict id for a requested item that does not belong to the
 * order under review. This is a guardrail outcome, not a customer-facing
 * policy rule — it is deliberately NOT part of POLICY_RULES and is never
 * rendered into the policy document.
 */
export const UNKNOWN_ITEM = "unknown_item" as const;
export type UnknownItemId = typeof UNKNOWN_ITEM;

// ---------------------------------------------------------------------------
// Typed accessors — the only sanctioned way to read rule parameters.
// Engine and renderer take a `rules` array (defaulting to POLICY_RULES) and
// read parameters through these, so behavior is provably data-driven.
// ---------------------------------------------------------------------------

/** Find a rule by id, narrowing to its concrete member of the union. */
export function getRule<Id extends PolicyRuleId>(
  rules: readonly PolicyRule[],
  id: Id,
): Extract<PolicyRule, { id: Id }> {
  const rule = rules.find(
    (r): r is Extract<PolicyRule, { id: Id }> => r.id === id,
  );
  if (!rule) {
    throw new Error(`Policy rule "${id}" is missing from the provided rule set`);
  }
  return rule;
}

/** Days after delivery during which items remain refundable (inclusive). */
export function getWindowDays(rules: readonly PolicyRule[] = POLICY_RULES): number {
  return getRule(rules, "return_window").params.windowDays;
}

/** Refundable-cents amount above which (strictly) a refund escalates. */
export function getThresholdCents(rules: readonly PolicyRule[] = POLICY_RULES): number {
  return getRule(rules, "escalation_threshold").params.thresholdCents;
}
