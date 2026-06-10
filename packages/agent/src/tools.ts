// ---------------------------------------------------------------------------
// The agent's tools — the security perimeter between the model and the data.
//
// AGENT_TOOLS is a CLOSED registry of exactly six tools (asserted by test):
// no shell, no eval, no SQL surface exists, and all DB access below is
// parameterized Drizzle. The model supplies order/item ids and a reason —
// never an amount, never a verdict, never an identity:
//
//   - Session-scoped identity: ToolContext carries the customer resolved
//     ONCE from the conversations row by the caller. It is never a tool
//     parameter, so there is nothing for a prompt to inject. Order lookups
//     are WHERE id = ? AND customer_id = ?, making foreign and nonexistent
//     ids indistinguishable: both return the identical {error:'not_found'}
//     and write one 'order_not_found' guardrail step.
//   - Deterministic re-validation: process_refund and escalate_to_human
//     re-fetch fresh rows and re-run the T2 eligibility engine server-side,
//     computing amounts from DB prices over eligible items only. Anything
//     the model claimed earlier in the conversation is irrelevant.
//   - Exactly-once money movement: the refund id doubles as the gateway
//     idempotency key; a retryable gateway failure is retried exactly once
//     with the SAME key (attempt-1 error row + attempt-2 ok row in the
//     trace), and the >$threshold path returns requires_escalation without
//     ever reaching the gateway call.
// ---------------------------------------------------------------------------

import {
  appSettings,
  customers,
  orderItems,
  orders,
  refunds,
  type Db,
} from "@loopp/db";
import { newId } from "@loopp/shared";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import {
  checkRefundEligibility,
  type EligibilityResult,
} from "./eligibility";
import { GatewayUnavailableError, type MockPaymentGateway } from "./gateway";
import type { LlmToolDefinition, LlmToolInputSchema } from "./llm";
import { renderPolicyMarkdown } from "./render";
import { getThresholdCents } from "./rules";
import type { RecordStep } from "./trace";

// --- Context & execution types ----------------------------------------------

/**
 * Everything a tool handler may touch. The caller (the agent loop, or a test
 * harness) builds one per run; the customer identity in it comes from the
 * conversations row, never from model input.
 */
export interface ToolContext {
  db: Db;
  conversationId: string;
  customerId: string;
  runId: string;
  /** Injectable clock for business timestamps and eligibility checks. */
  now: () => Date;
  gateway: MockPaymentGateway;
  /** Trace sink — tool_call steps from the executor, guardrails from handlers. */
  recordStep: RecordStep;
}

/**
 * Mutable state shared across retry attempts of ONE tool call. process_refund
 * stashes its refund id here before the first gateway attempt so a retry
 * reuses the SAME idempotency key — that is what makes the retry exactly-once.
 */
export interface ToolRetryContext {
  refundId?: string;
}

/** What the loop turns into a tool_result block for the model. */
export interface ToolExecution {
  /** JSON-serializable tool output (success or structured error object). */
  output: unknown;
  /** Mirrors is_error on the tool_result block. */
  isError: boolean;
}

export type AgentToolName =
  | "get_customer_context"
  | "get_order"
  | "check_refund_eligibility"
  | "process_refund"
  | "escalate_to_human"
  | "get_policy";

type StrictObjectSchema = z.ZodObject<z.ZodRawShape, "strict">;

export interface AgentTool {
  readonly name: AgentToolName;
  readonly description: string;
  /** Runtime validator — .strict(), so unknown keys are rejected. */
  readonly zodSchema: StrictObjectSchema;
  /** Hand-written API input_schema; a test pins its keys to the zod shape. */
  readonly jsonSchema: LlmToolInputSchema;
  /** Invoked with zod-validated input only (executeTool parses first). */
  readonly run: (
    input: unknown,
    ctx: ToolContext,
    retry: ToolRetryContext,
  ) => Promise<unknown>;
}

/** Keeps handlers typed against their own zod schema without casts at call sites. */
function defineTool<S extends StrictObjectSchema>(definition: {
  name: AgentToolName;
  description: string;
  zodSchema: S;
  jsonSchema: LlmToolInputSchema;
  handler: (
    args: z.output<S>,
    ctx: ToolContext,
    retry: ToolRetryContext,
  ) => Promise<unknown>;
}): AgentTool {
  return {
    name: definition.name,
    description: definition.description,
    zodSchema: definition.zodSchema,
    jsonSchema: definition.jsonSchema,
    run: (input, ctx, retry) =>
      definition.handler(input as z.output<S>, ctx, retry),
  };
}

// --- Shared input fragments ---------------------------------------------------

const orderIdField = z.string().min(1).max(64);
const itemIdsField = z.array(z.string().min(1).max(64)).min(1).max(50);
const reasonField = z.string().min(1).max(2000);

const ORDER_ID_JSON = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  description: "An order id from the customer's own order history, e.g. ord_1001.",
} as const;

const ITEM_IDS_JSON = {
  type: "array",
  items: { type: "string", minLength: 1, maxLength: 64 },
  minItems: 1,
  maxItems: 50,
  description: "Ids of line items belonging to that order, e.g. itm_1001_1.",
} as const;

const REASON_JSON = {
  type: "string",
  minLength: 1,
  maxLength: 2000,
  description: "The customer's stated reason for the refund request.",
} as const;

const EMPTY_INPUT_JSON: LlmToolInputSchema = {
  type: "object",
  properties: {},
  required: [],
  additionalProperties: false,
};

// --- Shared lookups -------------------------------------------------------------

/**
 * The one not_found shape, shared by every order-scoped tool so foreign and
 * nonexistent ids produce deep-equal responses (no existence leak).
 */
const NOT_FOUND = Object.freeze({ error: "not_found" as const });

type OrderRow = typeof orders.$inferSelect;

/**
 * Load an order scoped to the session customer. A miss — whether the id does
 * not exist or belongs to someone else — returns null after writing one
 * 'order_not_found' guardrail step; callers then return NOT_FOUND verbatim.
 */
async function loadScopedOrder(
  ctx: ToolContext,
  tool: AgentToolName,
  orderId: string,
): Promise<OrderRow | null> {
  const rows = await ctx.db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.customerId, ctx.customerId)))
    .limit(1);

  const order = rows[0];
  if (order === undefined) {
    await ctx.recordStep({
      type: "guardrail",
      name: "order_not_found",
      attempt: 1,
      input: { tool, orderId },
      output: NOT_FOUND,
      durationMs: 0,
      startedAt: ctx.now(),
    });
    return null;
  }
  return order;
}

type RefundRow = typeof refunds.$inferSelect;

/** Non-rejected refunds for the order — the rows that lock items. */
async function loadPriorRefunds(db: Db, orderId: string): Promise<RefundRow[]> {
  return db
    .select()
    .from(refunds)
    .where(and(eq(refunds.orderId, orderId), ne(refunds.status, "rejected")))
    .orderBy(asc(refunds.createdAt));
}

/**
 * Run the T2 engine on freshly fetched rows. Everything downstream of this
 * call is derived from the database, never from model input.
 */
async function runEligibility(
  ctx: ToolContext,
  order: OrderRow,
  itemIds: string[],
): Promise<{ result: EligibilityResult; priorRefunds: RefundRow[] }> {
  const items = await ctx.db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  const priorRefunds = await loadPriorRefunds(ctx.db, order.id);

  const result = checkRefundEligibility(
    {
      order: {
        id: order.id,
        status: order.status,
        deliveredAt: order.deliveredAt,
        shippingCents: order.shippingCents,
      },
      items,
      priorRefunds,
    },
    itemIds,
    ctx.now(),
  );
  return { result, priorRefunds };
}

/**
 * Duplicate guard: the existing non-rejected refund that already covers any
 * of the requested items, if there is one. Combined with "nothing new is
 * eligible", a repeat request reports that refund's current status instead
 * of creating a duplicate row.
 */
function findCoveringRefund(
  priorRefunds: RefundRow[],
  requestedItemIds: string[],
): RefundRow | undefined {
  const requested = new Set(requestedItemIds);
  return priorRefunds.find((refund) =>
    refund.itemIds.some((itemId) => requested.has(itemId)),
  );
}

function alreadyRefunded(refund: RefundRow) {
  return {
    result: "already_refunded" as const,
    refundId: refund.id,
    status: refund.status,
    amountCents: refund.amountCents,
  };
}

function eligibleItemIds(result: EligibilityResult): string[] {
  return result.verdicts
    .filter((verdict) => verdict.eligible)
    .map((verdict) => verdict.itemId);
}

/** Fresh read per call — no caching, so the admin chaos toggle works live. */
async function readFaultInjection(db: Db): Promise<boolean> {
  const rows = await db
    .select()
    .from(appSettings)
    .where(eq(appSettings.key, "fault_injection"))
    .limit(1);
  return rows[0]?.value === true;
}

// --- The six tools ---------------------------------------------------------------

const getCustomerContext = defineTool({
  name: "get_customer_context",
  description:
    "Look up the signed-in customer's profile and order history: name, email, and one summary line per order (id, status, ordered/delivered dates, total in cents, item count). Call this first to ground the conversation in the customer's real orders.",
  zodSchema: z.object({}).strict(),
  jsonSchema: EMPTY_INPUT_JSON,
  handler: async (_args, ctx) => {
    const customerRows = await ctx.db
      .select({ name: customers.name, email: customers.email })
      .from(customers)
      .where(eq(customers.id, ctx.customerId))
      .limit(1);
    const customer = customerRows[0];
    if (customer === undefined) {
      // Unreachable when the conversation row exists (FK), but never guess.
      throw new Error(`Session customer row is missing`);
    }

    const orderRows = await ctx.db
      .select()
      .from(orders)
      .where(eq(orders.customerId, ctx.customerId))
      .orderBy(desc(orders.orderedAt));

    const itemCounts = new Map<string, number>();
    if (orderRows.length > 0) {
      const itemRows = await ctx.db
        .select({ orderId: orderItems.orderId })
        .from(orderItems)
        .where(
          inArray(
            orderItems.orderId,
            orderRows.map((order) => order.id),
          ),
        );
      for (const item of itemRows) {
        itemCounts.set(item.orderId, (itemCounts.get(item.orderId) ?? 0) + 1);
      }
    }

    return {
      customer,
      orders: orderRows.map((order) => ({
        id: order.id,
        status: order.status,
        orderedAt: order.orderedAt.toISOString(),
        deliveredAt: order.deliveredAt?.toISOString() ?? null,
        totalCents: order.totalCents,
        itemCount: itemCounts.get(order.id) ?? 0,
      })),
    };
  },
});

const getOrder = defineTool({
  name: "get_order",
  description:
    "Fetch one of the signed-in customer's orders, including every line item (id, name, category, unit price in cents, quantity, final-sale flag) and the shipping charge. Returns {error:'not_found'} if no such order exists on this customer's account.",
  zodSchema: z.object({ orderId: orderIdField }).strict(),
  jsonSchema: {
    type: "object",
    properties: { orderId: ORDER_ID_JSON },
    required: ["orderId"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const order = await loadScopedOrder(ctx, "get_order", args.orderId);
    if (order === null) return NOT_FOUND;

    const items = await ctx.db
      .select({
        id: orderItems.id,
        name: orderItems.name,
        category: orderItems.category,
        unitPriceCents: orderItems.unitPriceCents,
        quantity: orderItems.quantity,
        isFinalSale: orderItems.isFinalSale,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id));

    return {
      id: order.id,
      status: order.status,
      orderedAt: order.orderedAt.toISOString(),
      deliveredAt: order.deliveredAt?.toISOString() ?? null,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      items,
    };
  },
});

const checkEligibility = defineTool({
  name: "check_refund_eligibility",
  description:
    "Run the deterministic refund-policy engine over specific items of one of the customer's orders. Returns one verdict per item (eligible, or the policy rule that denies it), the refundable total in cents, and whether processing would require escalation to a human. Read-only — no refund is created.",
  zodSchema: z.object({ orderId: orderIdField, itemIds: itemIdsField }).strict(),
  jsonSchema: {
    type: "object",
    properties: { orderId: ORDER_ID_JSON, itemIds: ITEM_IDS_JSON },
    required: ["orderId", "itemIds"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const order = await loadScopedOrder(
      ctx,
      "check_refund_eligibility",
      args.orderId,
    );
    if (order === null) return NOT_FOUND;

    const { result } = await runEligibility(ctx, order, args.itemIds);
    return result;
  },
});

const processRefund = defineTool({
  name: "process_refund",
  description:
    "Execute a refund for specific items of one of the customer's orders. The server re-checks eligibility against the policy and computes the refund amount from database prices — an amount cannot be specified. Returns result 'processed' (refund executed, with id and amount in cents), 'ineligible' (per-item policy citations), 'requires_escalation' (over the review threshold — use escalate_to_human), or 'already_refunded' (an existing refund covers these items).",
  zodSchema: z
    .object({ orderId: orderIdField, itemIds: itemIdsField, reason: reasonField })
    .strict(),
  jsonSchema: {
    type: "object",
    properties: {
      orderId: ORDER_ID_JSON,
      itemIds: ITEM_IDS_JSON,
      reason: REASON_JSON,
    },
    required: ["orderId", "itemIds", "reason"],
    additionalProperties: false,
  },
  handler: async (args, ctx, retry) => {
    const order = await loadScopedOrder(ctx, "process_refund", args.orderId);
    if (order === null) return NOT_FOUND;

    // Fresh rows, fresh engine run — nothing model-supplied survives this.
    const { result, priorRefunds } = await runEligibility(
      ctx,
      order,
      args.itemIds,
    );

    if (result.refundableCents <= 0) {
      // Duplicate guard: a repeat request against an already-covered item
      // reports the existing refund's status — no new row, no second payout.
      const covering = findCoveringRefund(priorRefunds, args.itemIds);
      if (covering !== undefined) return alreadyRefunded(covering);
      return { result: "ineligible" as const, verdicts: result.verdicts };
    }

    if (result.refundableCents > getThresholdCents()) {
      // Over the review threshold: the gateway call below is unreachable —
      // this tool cannot move more than the policy allows.
      return {
        result: "requires_escalation" as const,
        refundableCents: result.refundableCents,
      };
    }

    // Server-computed facts only: eligible items and their DB-price subtotal.
    const itemIds = eligibleItemIds(result);
    const amountCents = result.refundableCents;

    // The refund id is the gateway idempotency key. It is allocated once and
    // pinned in the retry context, so a retried attempt reuses the SAME key
    // and the gateway can never execute twice for one refund.
    const refundId = retry.refundId ?? newId("ref");
    retry.refundId = refundId;

    const faultInjection = await readFaultInjection(ctx.db);
    const { gatewayRef } = await ctx.gateway.processRefundPayment(
      refundId,
      amountCents,
      { faultInjection },
    );

    const now = ctx.now();
    await ctx.db.insert(refunds).values({
      id: refundId,
      orderId: order.id,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      amountCents,
      itemIds,
      reason: args.reason,
      status: "processed",
      decidedBy: "agent",
      gatewayRef,
      createdAt: now,
      resolvedAt: now,
    });

    return {
      result: "processed" as const,
      refundId,
      amountCents,
      itemIds,
      gatewayRef,
      verdicts: result.verdicts,
    };
  },
});

const escalateToHuman = defineTool({
  name: "escalate_to_human",
  description:
    "Escalate a refund request for specific items of one of the customer's orders to a human specialist — required when process_refund reports requires_escalation. The server re-checks eligibility and computes the amount from database prices; no money moves until a human approves. Returns result 'escalated' (with id and amount in cents), 'ineligible', or 'already_refunded'.",
  zodSchema: z
    .object({ orderId: orderIdField, itemIds: itemIdsField, reason: reasonField })
    .strict(),
  jsonSchema: {
    type: "object",
    properties: {
      orderId: ORDER_ID_JSON,
      itemIds: ITEM_IDS_JSON,
      reason: REASON_JSON,
    },
    required: ["orderId", "itemIds", "reason"],
    additionalProperties: false,
  },
  handler: async (args, ctx) => {
    const order = await loadScopedOrder(ctx, "escalate_to_human", args.orderId);
    if (order === null) return NOT_FOUND;

    // Same scoping, duplicate guard, and re-validation as process_refund.
    const { result, priorRefunds } = await runEligibility(
      ctx,
      order,
      args.itemIds,
    );

    if (result.refundableCents <= 0) {
      const covering = findCoveringRefund(priorRefunds, args.itemIds);
      if (covering !== undefined) return alreadyRefunded(covering);
      return { result: "ineligible" as const, verdicts: result.verdicts };
    }

    const itemIds = eligibleItemIds(result);
    const amountCents = result.refundableCents;
    const refundId = newId("ref");

    // Pending human review: no decider, no gateway reference, unresolved.
    await ctx.db.insert(refunds).values({
      id: refundId,
      orderId: order.id,
      customerId: ctx.customerId,
      conversationId: ctx.conversationId,
      runId: ctx.runId,
      amountCents,
      itemIds,
      reason: args.reason,
      status: "escalated",
      decidedBy: null,
      gatewayRef: null,
      createdAt: ctx.now(),
      resolvedAt: null,
    });

    return {
      result: "escalated" as const,
      refundId,
      amountCents,
      itemIds,
      verdicts: result.verdicts,
    };
  },
});

const getPolicy = defineTool({
  name: "get_policy",
  description:
    "Fetch the current customer-facing refund policy as markdown — the same document the eligibility engine enforces. Use it to quote or explain policy rules accurately.",
  zodSchema: z.object({}).strict(),
  jsonSchema: EMPTY_INPUT_JSON,
  handler: async () => ({ markdown: renderPolicyMarkdown() }),
});

/**
 * The CLOSED capability surface: exactly these six tools exist, nothing else.
 * tools.test.ts asserts the registry never grows or shrinks silently.
 */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getCustomerContext,
  getOrder,
  checkEligibility,
  processRefund,
  escalateToHuman,
  getPolicy,
];

/** What the loop sends to the API as the `tools` parameter. */
export const AGENT_TOOL_DEFINITIONS: readonly LlmToolDefinition[] =
  AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.jsonSchema,
  }));

// --- Executor ---------------------------------------------------------------------

/** Attempt 1 plus exactly one retry on a retryable gateway error. */
const MAX_TOOL_ATTEMPTS = 2;

/**
 * Dispatch one model-requested tool call: zod-validate the raw input, run the
 * handler, and persist one tool_call step PER ATTEMPT (a retried gateway
 * failure yields attempt=1 with error and attempt=2 ok, same refund id).
 * Never throws on bad model input — validation failures come back as
 * structured {error:'invalid_input'} results flagged isError.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolExecution> {
  const tool = AGENT_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    const output = { error: "unknown_tool" as const, tool: name };
    await ctx.recordStep({
      type: "tool_call",
      name,
      attempt: 1,
      input: rawInput,
      output,
      error: `Unknown tool "${name}" — the registry has exactly ${AGENT_TOOLS.length} tools`,
      durationMs: 0,
      startedAt: ctx.now(),
    });
    return { output, isError: true };
  }

  const parsed = tool.zodSchema.safeParse(rawInput);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
      message: issue.message,
    }));
    const output = { error: "invalid_input" as const, issues };
    await ctx.recordStep({
      type: "tool_call",
      name,
      attempt: 1,
      input: rawInput,
      output,
      error: `invalid_input: ${issues
        .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
        .join("; ")}`,
      durationMs: 0,
      startedAt: ctx.now(),
    });
    return { output, isError: true };
  }

  const retry: ToolRetryContext = {};
  for (let attempt = 1; attempt <= MAX_TOOL_ATTEMPTS; attempt += 1) {
    const startedAt = ctx.now();
    const startedClock = performance.now();
    try {
      const output = await tool.run(parsed.data, ctx, retry);
      await ctx.recordStep({
        type: "tool_call",
        name,
        attempt,
        input: parsed.data,
        output,
        durationMs: Math.round(performance.now() - startedClock),
        startedAt,
      });
      return { output, isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof GatewayUnavailableError;
      await ctx.recordStep({
        type: "tool_call",
        name,
        attempt,
        input: parsed.data,
        error: message,
        durationMs: Math.round(performance.now() - startedClock),
        startedAt,
      });
      if (retryable && attempt < MAX_TOOL_ATTEMPTS) continue;
      return { output: { error: "tool_failed" as const, message }, isError: true };
    }
  }

  // The loop above always returns; this satisfies control-flow analysis.
  throw new Error("executeTool: unreachable");
}
