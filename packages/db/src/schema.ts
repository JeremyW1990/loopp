import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// CRM: customers, orders, order items
// ---------------------------------------------------------------------------

export const orderStatus = pgEnum("order_status", [
  "processing",
  "shipped",
  "delivered",
  "cancelled",
]);

export const customers = pgTable("customers", {
  id: text("id").primaryKey(), // cus_001
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
});

export const orders = pgTable(
  "orders",
  {
    id: text("id").primaryKey(), // ord_1001
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    status: orderStatus("status").notNull(),
    orderedAt: timestamp("ordered_at", { withTimezone: true }).notNull(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    shippingCents: integer("shipping_cents").notNull().default(0),
    totalCents: integer("total_cents").notNull(), // items + shipping
  },
  (t) => [index("orders_customer_idx").on(t.customerId)],
);

export const orderItems = pgTable(
  "order_items",
  {
    id: text("id").primaryKey(), // itm_1001_1
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    name: text("name").notNull(),
    category: text("category").notNull(),
    unitPriceCents: integer("unit_price_cents").notNull(),
    quantity: integer("quantity").notNull().default(1),
    isFinalSale: boolean("is_final_sale").notNull().default(false),
  },
  (t) => [index("order_items_order_idx").on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Refunds — rows exist only for executed or escalated refund requests.
// Policy denials never create rows; they're visible in the agent trace.
// ---------------------------------------------------------------------------

export const refundStatus = pgEnum("refund_status", [
  "processed", // executed by the agent within policy
  "escalated", // awaiting human review (e.g. amount over threshold)
  "approved", // escalation approved by admin and executed
  "rejected", // escalation rejected by admin
]);

export const refundDecider = pgEnum("refund_decider", ["agent", "admin"]);

export const refunds = pgTable(
  "refunds",
  {
    id: text("id").primaryKey(), // ref_xxx
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id),
    customerId: text("customer_id")
      .notNull()
      .references(() => customers.id),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    amountCents: integer("amount_cents").notNull(),
    itemIds: jsonb("item_ids").$type<string[]>().notNull(),
    reason: text("reason").notNull(),
    status: refundStatus("status").notNull(),
    decidedBy: refundDecider("decided_by"),
    adminNote: text("admin_note"),
    gatewayRef: text("gateway_ref"), // mock payment gateway reference
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [index("refunds_order_idx").on(t.orderId)],
);

// ---------------------------------------------------------------------------
// Conversations & messages (customer-facing chat)
// ---------------------------------------------------------------------------

export const messageRole = pgEnum("message_role", ["user", "assistant"]);

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey(), // conv_xxx
  customerId: text("customer_id")
    .notNull()
    .references(() => customers.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(), // msg_xxx
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: messageRole("role").notNull(),
    content: text("content").notNull(),
    runId: text("run_id"), // set on assistant messages produced by a run
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId)],
);

// ---------------------------------------------------------------------------
// Agent observability: one run per processed user turn, one step per
// LLM call / tool call / guardrail event. This is the trace the admin
// dashboard renders: tool I/O, retries, token cost, latency.
// ---------------------------------------------------------------------------

export const runStatus = pgEnum("run_status", [
  "running",
  "completed",
  "failed",
]);

export const stepType = pgEnum("step_type", [
  "llm_call",
  "tool_call",
  "guardrail",
]);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(), // run_xxx
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    status: runStatus("status").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6 })
      .notNull()
      .default("0"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("agent_runs_conversation_idx").on(t.conversationId)],
);

export const agentSteps = pgTable(
  "agent_steps",
  {
    id: serial("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => agentRuns.id),
    seq: integer("seq").notNull(),
    type: stepType("type").notNull(),
    name: text("name").notNull(), // tool name, model name, or guardrail kind
    attempt: integer("attempt").notNull().default(1), // >1 marks a retry
    input: jsonb("input").$type<unknown>(),
    output: jsonb("output").$type<unknown>(),
    error: text("error"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    durationMs: integer("duration_ms"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("agent_steps_run_idx").on(t.runId)],
);

// ---------------------------------------------------------------------------
// App settings (key/value) — e.g. the fault-injection toggle for demos
// ---------------------------------------------------------------------------

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
});
