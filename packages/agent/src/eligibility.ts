// ---------------------------------------------------------------------------
// Pure, deterministic refund-eligibility engine.
//
// No I/O of any kind: callers (the T3 agent tools) load the order, its items,
// and any prior refunds from the database and pass plain data in together
// with the `now` instant — the engine never reads the wall clock, the
// environment, the filesystem, or the network, so the same inputs always
// produce the same result. All money is integer cents. Policy parameters
// (return window, escalation threshold) are read from the passed rule set via
// the typed accessors in rules.ts, so behavior is provably driven by
// POLICY_RULES data — the numeric literals live only there.
// ---------------------------------------------------------------------------

import { daysBetween } from "@loopp/shared";
import {
  POLICY_RULES,
  UNKNOWN_ITEM,
  getThresholdCents,
  getWindowDays,
  type PolicyRule,
  type UnknownItemId,
} from "./rules";

// --- Input shapes ----------------------------------------------------------
// Plain structural interfaces, deliberately assignment-compatible with the
// row shapes in packages/db/src/schema.ts (orders, order_items, refunds) so
// callers can pass DB rows straight through; extra row fields (customerId,
// name, totalCents, ...) are simply ignored.

export type EligibilityOrderStatus =
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";

export interface EligibilityOrder {
  id: string;
  status: EligibilityOrderStatus;
  /** Null until the order is delivered. */
  deliveredAt: Date | null;
  /** Shipping paid on the order — never refundable, never summed. */
  shippingCents: number;
}

export interface EligibilityItem {
  id: string;
  unitPriceCents: number;
  quantity: number;
  isFinalSale: boolean;
}

export type PriorRefundStatus =
  | "processed"
  | "escalated"
  | "approved"
  | "rejected";

export interface PriorRefund {
  itemIds: string[];
  status: PriorRefundStatus;
}

export interface EligibilityInput {
  order: EligibilityOrder;
  items: EligibilityItem[];
  priorRefunds: PriorRefund[];
}

// --- Output shapes ---------------------------------------------------------

/** Rule ids a deny verdict can cite (policy rules plus the guardrail id). */
export type DenyRuleId =
  | UnknownItemId
  | "delivered_only"
  | "return_window"
  | "final_sale"
  | "no_double_refund";

/**
 * Per-item verdict. `ruleId` is present only on denials — an eligible
 * verdict carries no rule id at all.
 */
export type ItemVerdict =
  | { itemId: string; eligible: true; reason: string }
  | { itemId: string; eligible: false; ruleId: DenyRuleId; reason: string };

export interface EligibilityResult {
  /** One verdict per unique requested item id, in first-seen request order. */
  verdicts: ItemVerdict[];
  /**
   * Σ unitPriceCents × quantity over eligible items only. shippingCents is
   * never included (shipping_non_refundable).
   */
  refundableCents: number;
  /**
   * True iff refundableCents strictly exceeds the escalation threshold —
   * a refund of exactly the threshold amount processes without escalation.
   */
  requiresEscalation: boolean;
}

// --- Engine ----------------------------------------------------------------

/** Human label for a prior-refund status that locks an item. */
const PRIOR_REFUND_LABEL: Record<Exclude<PriorRefundStatus, "rejected">, string> =
  {
    processed: "a processed refund",
    escalated: "an open escalation",
    approved: "an approved escalation",
  };

function formatDayCount(days: number): string {
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * Decide, per requested item, whether a refund is allowed under the given
 * policy rules, and what the resulting refundable amount would be.
 *
 * Deny precedence is fixed — for each item the FIRST failing check below
 * decides the verdict (tests pin this order):
 *
 *   1. unknown_item     — requested id is not an item of this order
 *                         (guardrail outcome, not a customer-facing rule)
 *   2. delivered_only   — order.status !== "delivered" OR deliveredAt is null
 *   3. return_window    — daysSinceDelivery > windowDays. Day counting uses
 *                         @loopp/shared daysBetween (floor of ms/86_400_000):
 *                         partial days round down, so 30 days + 23h is still
 *                         day 30 → eligible.
 *   4. final_sale       — item is marked final sale
 *   5. no_double_refund — item appears in a prior refund with status
 *                         processed/escalated/approved; rejected does NOT
 *                         block (the lock is released)
 *
 * Requested ids are deduplicated (one verdict per unique id, first-seen
 * order); an empty request yields {verdicts: [], refundableCents: 0,
 * requiresEscalation: false}.
 */
export function checkRefundEligibility(
  input: EligibilityInput,
  requestedItemIds: string[],
  now: Date,
  rules: readonly PolicyRule[] = POLICY_RULES,
): EligibilityResult {
  const { order, items, priorRefunds } = input;
  const windowDays = getWindowDays(rules);
  const thresholdCents = getThresholdCents(rules);

  const itemsById = new Map(items.map((item) => [item.id, item]));

  // Item ids locked by a prior refund, mapped to the status that locks them.
  // "rejected" releases the item; every other status (processed, escalated,
  // approved) keeps it locked — an open escalation must block re-requests,
  // otherwise approving it later could pay the same item out twice.
  const lockedBy = new Map<string, Exclude<PriorRefundStatus, "rejected">>();
  for (const refund of priorRefunds) {
    if (refund.status === "rejected") continue;
    for (const id of refund.itemIds) {
      if (!lockedBy.has(id)) lockedBy.set(id, refund.status);
    }
  }

  // Days since delivery, or null when the order is not (verifiably)
  // delivered. Computed once from the caller-supplied `now`.
  const deliveredAt = order.status === "delivered" ? order.deliveredAt : null;
  const daysSinceDelivery =
    deliveredAt === null ? null : daysBetween(deliveredAt, now);

  // Checks 2–5, for an item that does belong to the order.
  function judgeKnownItem(item: EligibilityItem): ItemVerdict {
    // 2. delivered_only
    if (daysSinceDelivery === null) {
      return {
        itemId: item.id,
        eligible: false,
        ruleId: "delivered_only",
        reason:
          order.status === "delivered"
            ? `Order ${order.id} has no delivery date on record; only delivered orders are eligible for refunds.`
            : `Order ${order.id} has not been delivered (status: ${order.status}); only delivered orders are eligible for refunds.`,
      };
    }

    // 3. return_window
    if (daysSinceDelivery > windowDays) {
      return {
        itemId: item.id,
        eligible: false,
        ruleId: "return_window",
        reason: `Delivered ${formatDayCount(daysSinceDelivery)} ago, outside the ${windowDays}-day return window.`,
      };
    }

    // 4. final_sale
    if (item.isFinalSale) {
      return {
        itemId: item.id,
        eligible: false,
        ruleId: "final_sale",
        reason: "Item is marked final sale and is not eligible for a refund.",
      };
    }

    // 5. no_double_refund
    const lockingStatus = lockedBy.get(item.id);
    if (lockingStatus !== undefined) {
      return {
        itemId: item.id,
        eligible: false,
        ruleId: "no_double_refund",
        reason: `Item is already covered by ${PRIOR_REFUND_LABEL[lockingStatus]}; an item can be refunded only once.`,
      };
    }

    return {
      itemId: item.id,
      eligible: true,
      reason: `Delivered ${formatDayCount(daysSinceDelivery)} ago, within the ${windowDays}-day return window.`,
    };
  }

  const verdicts: ItemVerdict[] = [];
  let refundableCents = 0;

  // new Set(...) preserves first-occurrence order, giving one verdict per
  // unique requested id.
  for (const itemId of new Set(requestedItemIds)) {
    const item = itemsById.get(itemId);

    // 1. unknown_item (guardrail)
    if (item === undefined) {
      verdicts.push({
        itemId,
        eligible: false,
        ruleId: UNKNOWN_ITEM,
        reason: `Item ${itemId} does not belong to order ${order.id}.`,
      });
      continue;
    }

    const verdict = judgeKnownItem(item);
    verdicts.push(verdict);
    if (verdict.eligible) {
      refundableCents += item.unitPriceCents * item.quantity;
    }
  }

  return {
    verdicts,
    refundableCents,
    requiresEscalation: refundableCents > thresholdCents,
  };
}
