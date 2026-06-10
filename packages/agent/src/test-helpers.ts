// ---------------------------------------------------------------------------
// Test utilities for the DB-backed agent suites (tools.test.ts, loop.test.ts).
//
// Deliberately NOT exported from the package barrel — production code never
// imports this. Suites connect to the local compose Postgres, reseed via
// runSeed(db) in beforeAll (seed dates are relative to seed time, so a stale
// DB silently drifts out of the policy windows), and build per-test tool
// harnesses whose recordStep collects steps in memory for assertions.
// ---------------------------------------------------------------------------

import {
  conversations,
  createDb,
  orderItems,
  orders,
  refunds,
  type Db,
} from "@loopp/db";
import { daysBetween, newId } from "@loopp/shared";
import { expect } from "vitest";
import { MockPaymentGateway } from "./gateway";
import { getThresholdCents, getWindowDays } from "./rules";
import type { ToolContext } from "./tools";
import type { RecordStepInput } from "./trace";

export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

export interface TestDb {
  db: Db;
  /** Close the underlying connection pool (call in afterAll). */
  close: () => Promise<void>;
}

export function connectTestDb(): TestDb {
  const { db, sql } = createDb(TEST_DATABASE_URL);
  return { db, close: () => sql.end() };
}

/** Insert a conversation row for the given seeded customer and return its id. */
export async function createTestConversation(
  db: Db,
  customerId: string,
): Promise<string> {
  const id = newId("conv");
  await db.insert(conversations).values({ id, customerId, createdAt: new Date() });
  return id;
}

export interface StepRecorder {
  /** Every step recorded, in call order. */
  steps: RecordStepInput[];
  recordStep: (step: RecordStepInput) => Promise<void>;
}

/** In-memory recordStep sink for handler-level tests (no agent_steps rows). */
export function createStepRecorder(): StepRecorder {
  const steps: RecordStepInput[] = [];
  return {
    steps,
    recordStep: async (step) => {
      steps.push(step);
    },
  };
}

export interface ToolHarness {
  ctx: ToolContext;
  /** The in-memory trace this harness's ctx.recordStep writes to. */
  steps: RecordStepInput[];
  gateway: MockPaymentGateway;
  conversationId: string;
  runId: string;
}

/** Status mix the ledger sweep observed — callers assert suite-specific minimums. */
export interface RefundLedgerSummary {
  total: number;
  processed: number;
  escalated: number;
  approved: number;
  rejected: number;
}

/**
 * Sweep EVERY refunds row currently in the database and assert the project's
 * ledger invariants hold for each one — seeded rows and rows the suite just
 * created through the real tools alike:
 *
 *   1. Money: amountCents equals the DB-computed subtotal of the row's
 *      itemIds (unitPriceCents × quantity; shipping excluded) — for every
 *      row, because both creation paths compute server-side.
 *   2. Scope: every itemId belongs to the refund's order, and the refund's
 *      customerId matches the order's owner.
 *   3. Policy at decision time (non-rejected rows): no final-sale item, the
 *      order was delivered, and createdAt is within the return window of
 *      deliveredAt (same daysBetween arithmetic as the engine).
 *   4. Authority: decidedBy='agent' only on processed rows at or under the
 *      escalation threshold; any amount above it exists only as
 *      escalated/approved/rejected and never decidedBy='agent'.
 *   5. Lifecycle: processed rows carry a gatewayRef and resolvedAt; escalated
 *      rows have decidedBy/gatewayRef/resolvedAt all null (pending human).
 *   6. One refund per item: no itemId appears in two non-rejected rows.
 */
export async function assertRefundLedgerInvariants(
  db: Db,
): Promise<RefundLedgerSummary> {
  const refundRows = await db.select().from(refunds);
  const orderRows = await db.select().from(orders);
  const itemRows = await db.select().from(orderItems);

  const orderById = new Map(orderRows.map((order) => [order.id, order]));
  const itemById = new Map(itemRows.map((item) => [item.id, item]));
  const thresholdCents = getThresholdCents();
  const windowDays = getWindowDays();

  /** itemId → refundId of the non-rejected row that already locks it. */
  const lockedBy = new Map<string, string>();

  for (const refund of refundRows) {
    const label = `refund ${refund.id} (order ${refund.orderId})`;

    // 2. Scope: the order exists, belongs to the refund's customer, and every
    //    refunded item is one of that order's line items.
    const order = orderById.get(refund.orderId);
    expect(order, `${label}: order row missing`).toBeDefined();
    expect(refund.customerId, `${label}: customer mismatch`).toBe(
      order!.customerId,
    );
    expect(refund.itemIds.length, `${label}: empty itemIds`).toBeGreaterThan(0);
    const items = refund.itemIds.map((itemId) => {
      const item = itemById.get(itemId);
      expect(item, `${label}: unknown item ${itemId}`).toBeDefined();
      expect(item!.orderId, `${label}: item ${itemId} belongs to another order`).toBe(
        refund.orderId,
      );
      return item!;
    });

    // 1. Money: integer cents, equal to the DB subtotal of the refunded items.
    expect(
      Number.isSafeInteger(refund.amountCents),
      `${label}: amount must be integer cents`,
    ).toBe(true);
    const subtotalCents = items.reduce(
      (sum, item) => sum + item.unitPriceCents * item.quantity,
      0,
    );
    expect(
      refund.amountCents,
      `${label}: amount must equal the DB item subtotal (shipping excluded)`,
    ).toBe(subtotalCents);

    if (refund.status !== "rejected") {
      // 3. Policy at decision time.
      for (const item of items) {
        expect(
          item.isFinalSale,
          `${label}: final-sale item ${item.id} must never be refunded`,
        ).toBe(false);
      }
      expect(order!.status, `${label}: order never delivered`).toBe("delivered");
      expect(order!.deliveredAt, `${label}: deliveredAt missing`).not.toBeNull();
      const daysSinceDelivery = daysBetween(order!.deliveredAt!, refund.createdAt);
      expect(
        daysSinceDelivery,
        `${label}: decided ${daysSinceDelivery}d after delivery, window is ${windowDays}d`,
      ).toBeLessThanOrEqual(windowDays);
      expect(daysSinceDelivery, `${label}: decided before delivery`).toBeGreaterThanOrEqual(0);

      // 6. At most one non-rejected refund per item.
      for (const itemId of refund.itemIds) {
        const holder = lockedBy.get(itemId);
        expect(
          holder,
          `${label}: item ${itemId} already locked by non-rejected refund ${holder}`,
        ).toBeUndefined();
        lockedBy.set(itemId, refund.id);
      }
    }

    // 4. Authority boundary.
    if (refund.decidedBy === "agent") {
      expect(refund.status, `${label}: agent rows must be 'processed'`).toBe(
        "processed",
      );
      expect(
        refund.amountCents,
        `${label}: agent-decided amount exceeds the ${thresholdCents}¢ threshold`,
      ).toBeLessThanOrEqual(thresholdCents);
    }
    if (refund.amountCents > thresholdCents) {
      expect(
        ["escalated", "approved", "rejected"],
        `${label}: >threshold amounts only exist via the human path`,
      ).toContain(refund.status);
      expect(refund.decidedBy, `${label}: >threshold row decided by agent`).not.toBe(
        "agent",
      );
    }

    // 5. Lifecycle shape per status.
    if (refund.status === "processed") {
      expect(refund.gatewayRef, `${label}: processed without gatewayRef`).not.toBeNull();
      expect(refund.resolvedAt, `${label}: processed without resolvedAt`).not.toBeNull();
    }
    if (refund.status === "escalated") {
      expect(refund.decidedBy, `${label}: escalated rows are undecided`).toBeNull();
      expect(refund.gatewayRef, `${label}: escalated rows moved no money`).toBeNull();
      expect(refund.resolvedAt, `${label}: escalated rows are unresolved`).toBeNull();
    }
  }

  const count = (status: string) =>
    refundRows.filter((refund) => refund.status === status).length;
  return {
    total: refundRows.length,
    processed: count("processed"),
    escalated: count("escalated"),
    approved: count("approved"),
    rejected: count("rejected"),
  };
}

/**
 * Build a ToolContext for one seeded customer: a real conversations row (the
 * session identity source), a fresh gateway, and an in-memory step recorder.
 * Mirrors exactly what the agent loop hands to executeTool.
 */
export async function createToolHarness(
  db: Db,
  customerId: string,
  options: { gateway?: MockPaymentGateway; now?: () => Date } = {},
): Promise<ToolHarness> {
  const conversationId = await createTestConversation(db, customerId);
  const recorder = createStepRecorder();
  const gateway = options.gateway ?? new MockPaymentGateway();
  const runId = newId("run");

  return {
    ctx: {
      db,
      conversationId,
      customerId,
      runId,
      now: options.now ?? (() => new Date()),
      gateway,
      recordStep: recorder.recordStep,
    },
    steps: recorder.steps,
    gateway,
    conversationId,
    runId,
  };
}
