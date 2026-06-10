// ---------------------------------------------------------------------------
// Tool-layer tests — DB-backed, against the local compose Postgres, with an
// in-memory step recorder standing in for the run tracer. Reseeds via
// runSeed(db) in beforeAll (seed dates are relative to seed time). Tests
// within this file run sequentially and use disjoint seed orders for writes,
// so a single reseed keeps them independent. No ANTHROPIC_API_KEY, no LLM.
// ---------------------------------------------------------------------------

import {
  agentRuns,
  agentSteps,
  appSettings,
  refunds,
  runSeed,
} from "@loopp/db";
import { newId } from "@loopp/shared";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { computeCostUsd } from "./pricing";
import { renderPolicyMarkdown } from "./render";
import {
  assertRefundLedgerInvariants,
  connectTestDb,
  createTestConversation,
  createToolHarness,
  type TestDb,
} from "./test-helpers";
import { createRunTracer } from "./trace";
import {
  AGENT_TOOLS,
  AGENT_TOOL_DEFINITIONS,
  executeTool,
  type AgentToolName,
} from "./tools";

const EXPECTED_TOOL_NAMES: AgentToolName[] = [
  "get_customer_context",
  "get_order",
  "check_refund_eligibility",
  "process_refund",
  "escalate_to_human",
  "get_policy",
];

/** A schema-valid input per tool, used to probe strictness and caps. */
const VALID_INPUT: Record<AgentToolName, Record<string, unknown>> = {
  get_customer_context: {},
  get_order: { orderId: "ord_1001" },
  check_refund_eligibility: { orderId: "ord_1001", itemIds: ["itm_1001_1"] },
  process_refund: {
    orderId: "ord_1001",
    itemIds: ["itm_1001_1"],
    reason: "arrived chipped",
  },
  escalate_to_human: {
    orderId: "ord_1001",
    itemIds: ["itm_1001_1"],
    reason: "arrived chipped",
  },
  get_policy: {},
};

let testDb: TestDb;

beforeAll(async () => {
  testDb = connectTestDb();
  await runSeed(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

async function refundRowsFor(orderId: string) {
  return testDb.db
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(asc(refunds.createdAt));
}

// --- Registry ---------------------------------------------------------------

describe("AGENT_TOOLS registry", () => {
  it("contains exactly six tools — the closed capability surface", () => {
    expect(AGENT_TOOLS).toHaveLength(6);
    expect(AGENT_TOOLS.map((tool) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
    // No shell, eval, SQL, or any other capability sneaks in by name.
    expect(AGENT_TOOL_DEFINITIONS.map((def) => def.name)).toEqual(
      EXPECTED_TOOL_NAMES,
    );
  });

  it("exposes API definitions that mirror the registry's jsonSchemas", () => {
    for (const tool of AGENT_TOOLS) {
      const definition = AGENT_TOOL_DEFINITIONS.find(
        (def) => def.name === tool.name,
      );
      expect(definition).toBeDefined();
      expect(definition?.description).toBe(tool.description);
      expect(definition?.inputSchema).toBe(tool.jsonSchema);
    }
  });

  it("no tool accepts an amount or a customer identity field", () => {
    for (const tool of AGENT_TOOLS) {
      const zodKeys = Object.keys(tool.zodSchema.shape);
      const jsonKeys = Object.keys(tool.jsonSchema.properties);
      for (const key of [...zodKeys, ...jsonKeys]) {
        expect(key).not.toMatch(/amount/i);
        expect(key).not.toMatch(/customer/i);
        expect(key).not.toMatch(/verdict|eligib/i);
      }
    }
  });

  it("every zod schema is strict: unknown keys, including amountCents, are rejected", () => {
    for (const tool of AGENT_TOOLS) {
      const valid = VALID_INPUT[tool.name];
      expect(tool.zodSchema.safeParse(valid).success).toBe(true);
      expect(
        tool.zodSchema.safeParse({ ...valid, amountCents: 1 }).success,
      ).toBe(false);
      expect(
        tool.zodSchema.safeParse({ ...valid, unexpected: true }).success,
      ).toBe(false);
    }
  });

  it("jsonSchema stays in sync with the zod shape (keys, required, closed)", () => {
    for (const tool of AGENT_TOOLS) {
      const zodKeys = Object.keys(tool.zodSchema.shape).sort();
      const jsonKeys = Object.keys(tool.jsonSchema.properties).sort();
      expect(jsonKeys).toEqual(zodKeys);
      // Every field is required — no optional surface for the model to skip.
      expect([...tool.jsonSchema.required].sort()).toEqual(zodKeys);
      expect(tool.jsonSchema.additionalProperties).toBe(false);
    }
  });

  it("caps inputs: itemIds 1..50, reason 1..2000, orderId 1..64", () => {
    const schema = AGENT_TOOLS.find(
      (tool) => tool.name === "process_refund",
    )?.zodSchema;
    if (schema === undefined) throw new Error("process_refund missing");
    const base = VALID_INPUT.process_refund;

    expect(schema.safeParse({ ...base, itemIds: [] }).success).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        itemIds: Array.from({ length: 51 }, (_, i) => `itm_${i}`),
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        ...base,
        itemIds: Array.from({ length: 50 }, (_, i) => `itm_${i}`),
      }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...base, reason: "" }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, reason: "x".repeat(2001) }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ ...base, reason: "x".repeat(2000) }).success,
    ).toBe(true);
    expect(schema.safeParse({ ...base, orderId: "" }).success).toBe(false);
    expect(
      schema.safeParse({ ...base, orderId: "o".repeat(65) }).success,
    ).toBe(false);
  });
});

// --- Session scoping & not_found parity ---------------------------------------

describe("session scoping", () => {
  it("foreign order id returns not_found and writes a guardrail step (every order-scoped tool)", async () => {
    // cus_001 probing cus_005's ord_1016 through each order-scoped tool.
    const probes: [AgentToolName, Record<string, unknown>][] = [
      ["get_order", { orderId: "ord_1016" }],
      ["check_refund_eligibility", { orderId: "ord_1016", itemIds: ["itm_1016_1"] }],
      ["process_refund", { orderId: "ord_1016", itemIds: ["itm_1016_1"], reason: "mine now" }],
      ["escalate_to_human", { orderId: "ord_1016", itemIds: ["itm_1016_1"], reason: "mine now" }],
    ];

    for (const [tool, input] of probes) {
      const harness = await createToolHarness(testDb.db, "cus_001");
      const execution = await executeTool(tool, input, harness.ctx);

      expect(execution.output).toEqual({ error: "not_found" });

      const guardrails = harness.steps.filter((step) => step.type === "guardrail");
      expect(guardrails).toHaveLength(1);
      expect(guardrails[0]).toMatchObject({
        type: "guardrail",
        name: "order_not_found",
        input: { tool, orderId: "ord_1016" },
        output: { error: "not_found" },
      });
      // The guardrail lands before the tool_call step that returned it.
      expect(harness.steps[0]?.type).toBe("guardrail");
      expect(harness.steps[1]).toMatchObject({
        type: "tool_call",
        name: tool,
        output: { error: "not_found" },
      });
      // A foreign probe never moves money or writes a refund.
      expect(harness.gateway.executionCount).toBe(0);
    }
    expect(await refundRowsFor("ord_1016")).toHaveLength(0);
  });

  it("not_found parity: nonexistent and foreign ids are indistinguishable (deep-equal, byte-identical)", async () => {
    const foreignHarness = await createToolHarness(testDb.db, "cus_001");
    const missingHarness = await createToolHarness(testDb.db, "cus_001");

    const foreign = await executeTool(
      "get_order",
      { orderId: "ord_1016" }, // exists, belongs to cus_005
      foreignHarness.ctx,
    );
    const missing = await executeTool(
      "get_order",
      { orderId: "ord_9999" }, // does not exist at all
      missingHarness.ctx,
    );

    expect(foreign.output).toEqual({ error: "not_found" });
    expect(missing.output).toEqual(foreign.output);
    expect(JSON.stringify(missing.output)).toBe(JSON.stringify(foreign.output));
    expect(missing.isError).toBe(foreign.isError);

    // Both write one guardrail step of identical shape (output included).
    const foreignGuardrail = foreignHarness.steps.find((s) => s.type === "guardrail");
    const missingGuardrail = missingHarness.steps.find((s) => s.type === "guardrail");
    expect(foreignGuardrail).toBeDefined();
    expect(missingGuardrail).toBeDefined();
    expect(missingGuardrail?.name).toBe(foreignGuardrail?.name);
    expect(missingGuardrail?.output).toEqual(foreignGuardrail?.output);
    expect(foreignGuardrail?.input).toEqual({ tool: "get_order", orderId: "ord_1016" });
    expect(missingGuardrail?.input).toEqual({ tool: "get_order", orderId: "ord_9999" });
  });
});

// --- Read tools ----------------------------------------------------------------

describe("get_customer_context", () => {
  it("returns the session customer and only their orders, newest first", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output, isError } = await executeTool("get_customer_context", {}, harness.ctx);

    expect(isError).toBe(false);
    const context = output as {
      customer: { name: string; email: string };
      orders: { id: string; totalCents: number; itemCount: number }[];
    };
    expect(context.customer).toEqual({
      name: "Maya Chen",
      email: "maya.chen@example.com",
    });
    expect(context.orders.map((order) => order.id)).toEqual([
      "ord_1001",
      "ord_1003",
      "ord_1002",
      "ord_1004",
      "ord_1005",
    ]);
    const happyPath = context.orders.find((order) => order.id === "ord_1001");
    // items 5999 + 2×3499 + shipping 799
    expect(happyPath).toMatchObject({ totalCents: 13796, itemCount: 2 });
  });

  it("a customer with zero orders gets an empty list, not an error", async () => {
    const harness = await createToolHarness(testDb.db, "cus_010");
    const { output, isError } = await executeTool("get_customer_context", {}, harness.ctx);

    expect(isError).toBe(false);
    expect((output as { orders: unknown[] }).orders).toEqual([]);
  });
});

describe("get_order", () => {
  it("returns the order with items, prices in integer cents, and final-sale flags", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output } = await executeTool("get_order", { orderId: "ord_1003" }, harness.ctx);

    expect(output).toMatchObject({
      id: "ord_1003",
      status: "delivered",
      shippingCents: 599,
      totalCents: 18999 + 14999 + 599,
      items: [
        {
          id: "itm_1003_1",
          name: "Silk Evening Dress",
          unitPriceCents: 18999,
          quantity: 1,
          isFinalSale: true,
        },
        {
          id: "itm_1003_2",
          name: "Leather Ankle Boots",
          unitPriceCents: 14999,
          quantity: 1,
          isFinalSale: false,
        },
      ],
    });
  });
});

describe("check_refund_eligibility", () => {
  it("reports eligible items with the refundable total computed from DB prices", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output } = await executeTool(
      "check_refund_eligibility",
      { orderId: "ord_1001", itemIds: ["itm_1001_1", "itm_1001_2"] },
      harness.ctx,
    );

    expect(output).toMatchObject({
      refundableCents: 5999 + 2 * 3499,
      requiresEscalation: false,
    });
    const { verdicts } = output as { verdicts: { eligible: boolean }[] };
    expect(verdicts).toHaveLength(2);
    expect(verdicts.every((verdict) => verdict.eligible)).toBe(true);
  });

  it("cites the denying rule id (final_sale, return_window, unknown_item)", async () => {
    const finalSale = await createToolHarness(testDb.db, "cus_005");
    const { output: finalSaleOut } = await executeTool(
      "check_refund_eligibility",
      { orderId: "ord_1016", itemIds: ["itm_1016_1"] },
      finalSale.ctx,
    );
    expect(finalSaleOut).toMatchObject({
      refundableCents: 0,
      verdicts: [{ itemId: "itm_1016_1", eligible: false, ruleId: "final_sale" }],
    });

    const window = await createToolHarness(testDb.db, "cus_001");
    const { output: windowOut } = await executeTool(
      "check_refund_eligibility",
      { orderId: "ord_1004", itemIds: ["itm_1004_1"] },
      window.ctx,
    );
    expect(windowOut).toMatchObject({
      verdicts: [{ eligible: false, ruleId: "return_window" }],
    });

    const unknown = await createToolHarness(testDb.db, "cus_001");
    const { output: unknownOut } = await executeTool(
      "check_refund_eligibility",
      { orderId: "ord_1001", itemIds: ["itm_9999"] },
      unknown.ctx,
    );
    expect(unknownOut).toMatchObject({
      verdicts: [{ itemId: "itm_9999", eligible: false, ruleId: "unknown_item" }],
    });
  });
});

// --- process_refund ---------------------------------------------------------------

describe("process_refund", () => {
  it("recomputes the amount from DB prices over eligible items — the model cannot influence it", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output, isError } = await executeTool(
      "process_refund",
      { orderId: "ord_1001", itemIds: ["itm_1001_1"], reason: "arrived chipped" },
      harness.ctx,
    );

    expect(isError).toBe(false);
    const processed = output as {
      result: string;
      refundId: string;
      amountCents: number;
      itemIds: string[];
      gatewayRef: string;
    };
    expect(processed.result).toBe("processed");
    // 5999 is the DB price of itm_1001_1 — nothing else can produce this.
    expect(processed.amountCents).toBe(5999);
    expect(processed.itemIds).toEqual(["itm_1001_1"]);
    expect(processed.gatewayRef).toBe(`gw_${processed.refundId}`);
    expect(harness.gateway.executionCount).toBe(1);

    const rows = await refundRowsFor("ord_1001");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: processed.refundId,
      customerId: "cus_001",
      conversationId: harness.conversationId,
      runId: harness.runId,
      amountCents: 5999,
      itemIds: ["itm_1001_1"],
      status: "processed",
      decidedBy: "agent",
      gatewayRef: processed.gatewayRef,
    });
    expect(rows[0]?.resolvedAt).not.toBeNull();

    // Asking again is caught by the duplicate guard — agent-created rows
    // lock items exactly like seeded ones. No second row, no second payout.
    const repeat = await createToolHarness(testDb.db, "cus_001");
    const { output: repeatOut } = await executeTool(
      "process_refund",
      { orderId: "ord_1001", itemIds: ["itm_1001_1"], reason: "asking again" },
      repeat.ctx,
    );
    expect(repeatOut).toEqual({
      result: "already_refunded",
      refundId: processed.refundId,
      status: "processed",
      amountCents: 5999,
    });
    expect(await refundRowsFor("ord_1001")).toHaveLength(1);
    expect(repeat.gateway.executionCount).toBe(0);
  });

  it("mixed cart: refunds the boots and cites final_sale for the dress (partial refund)", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output } = await executeTool(
      "process_refund",
      {
        orderId: "ord_1003",
        itemIds: ["itm_1003_1", "itm_1003_2"],
        reason: "wrong size on both",
      },
      harness.ctx,
    );

    expect(output).toMatchObject({
      result: "processed",
      amountCents: 14999, // boots only — the dress is final sale
      itemIds: ["itm_1003_2"],
      verdicts: [
        { itemId: "itm_1003_1", eligible: false, ruleId: "final_sale" },
        { itemId: "itm_1003_2", eligible: true },
      ],
    });

    const rows = await refundRowsFor("ord_1003");
    expect(rows).toHaveLength(1);
    // The row stores ELIGIBLE item ids only — the dress stays refundable-never,
    // and the no_double_refund lock covers exactly what was paid.
    expect(rows[0]?.itemIds).toEqual(["itm_1003_2"]);
    expect(rows[0]?.amountCents).toBe(14999);
  });

  it("shipping is never part of the computed amount", async () => {
    const harness = await createToolHarness(testDb.db, "cus_014");
    const { output } = await executeTool(
      "process_refund",
      { orderId: "ord_1034", itemIds: ["itm_1034_1"], reason: "bedding pilled" },
      harness.ctx,
    );

    // Item is 13499; order shipping of 1299 must not leak into the refund.
    expect(output).toMatchObject({ result: "processed", amountCents: 13499 });
  });

  it("exactly $500.00 (ord_1022) processes — the threshold is strictly greater-than", async () => {
    const harness = await createToolHarness(testDb.db, "cus_008");
    const { output } = await executeTool(
      "process_refund",
      { orderId: "ord_1022", itemIds: ["itm_1022_1"], reason: "chair wobbles" },
      harness.ctx,
    );

    expect(output).toMatchObject({ result: "processed", amountCents: 50000 });
    expect(harness.gateway.executionCount).toBe(1);
    expect(await refundRowsFor("ord_1022")).toHaveLength(1);
  });

  it("$525.00 (ord_1023) escalates: no gateway call, no row from process_refund; escalate_to_human creates the escalated row", async () => {
    const harness = await createToolHarness(testDb.db, "cus_008");
    const { output } = await executeTool(
      "process_refund",
      { orderId: "ord_1023", itemIds: ["itm_1023_1"], reason: "desk motor died" },
      harness.ctx,
    );

    // Pinned shape: the gateway branch is unreachable above the threshold.
    expect(output).toEqual({
      result: "requires_escalation",
      refundableCents: 52500,
    });
    expect(harness.gateway.executionCount).toBe(0);
    expect(await refundRowsFor("ord_1023")).toHaveLength(0);

    // The escalation path re-validates and writes the pending row itself.
    const { output: escalated } = await executeTool(
      "escalate_to_human",
      { orderId: "ord_1023", itemIds: ["itm_1023_1"], reason: "desk motor died" },
      harness.ctx,
    );
    expect(escalated).toMatchObject({
      result: "escalated",
      amountCents: 52500,
      itemIds: ["itm_1023_1"],
    });
    expect(harness.gateway.executionCount).toBe(0);

    const rows = await refundRowsFor("ord_1023");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: "escalated",
      decidedBy: null,
      gatewayRef: null,
      amountCents: 52500,
      itemIds: ["itm_1023_1"],
      resolvedAt: null,
    });

    // Repeats in either direction report the open escalation, no new rows.
    const { output: escalateAgain } = await executeTool(
      "escalate_to_human",
      { orderId: "ord_1023", itemIds: ["itm_1023_1"], reason: "still waiting" },
      harness.ctx,
    );
    expect(escalateAgain).toMatchObject({
      result: "already_refunded",
      status: "escalated",
      refundId: rows[0]?.id,
    });
    const { output: processAgain } = await executeTool(
      "process_refund",
      { orderId: "ord_1023", itemIds: ["itm_1023_1"], reason: "just pay it" },
      harness.ctx,
    );
    expect(processAgain).toMatchObject({
      result: "already_refunded",
      status: "escalated",
    });
    expect(await refundRowsFor("ord_1023")).toHaveLength(1);
    expect(harness.gateway.executionCount).toBe(0);
  });

  it("ineligible: per-item rule citations and no row (escalate_to_human re-validates the same way)", async () => {
    const harness = await createToolHarness(testDb.db, "cus_005");

    const processed = await executeTool(
      "process_refund",
      { orderId: "ord_1016", itemIds: ["itm_1016_1"], reason: "scratched lens" },
      harness.ctx,
    );
    expect(processed.output).toMatchObject({
      result: "ineligible",
      verdicts: [{ itemId: "itm_1016_1", eligible: false, ruleId: "final_sale" }],
    });

    // escalate_to_human cannot be used to smuggle an ineligible item past
    // the policy: same fresh engine run, same denial.
    const escalated = await executeTool(
      "escalate_to_human",
      { orderId: "ord_1016", itemIds: ["itm_1016_1"], reason: "scratched lens" },
      harness.ctx,
    );
    expect(escalated.output).toMatchObject({
      result: "ineligible",
      verdicts: [{ eligible: false, ruleId: "final_sale" }],
    });

    expect(await refundRowsFor("ord_1016")).toHaveLength(0);
    expect(harness.gateway.executionCount).toBe(0);
  });

  it("duplicate guard: repeat request against ord_1009 returns the existing refund's status, row count unchanged", async () => {
    const before = await refundRowsFor("ord_1009");
    expect(before).toHaveLength(1); // ref_seed_0001

    const harness = await createToolHarness(testDb.db, "cus_003");
    const { output, isError } = await executeTool(
      "process_refund",
      { orderId: "ord_1009", itemIds: ["itm_1009_1"], reason: "still broken" },
      harness.ctx,
    );

    expect(isError).toBe(false);
    expect(output).toEqual({
      result: "already_refunded",
      refundId: "ref_seed_0001",
      status: "processed",
      amountCents: 27999,
    });
    expect(await refundRowsFor("ord_1009")).toHaveLength(1);
    expect(harness.gateway.executionCount).toBe(0);
  });

  it("fault injection: attempt-1 error row + attempt-2 ok row, same refund id, money moves exactly once", async () => {
    await testDb.db
      .update(appSettings)
      .set({ value: true })
      .where(eq(appSettings.key, "fault_injection"));

    try {
      const harness = await createToolHarness(testDb.db, "cus_002");
      const { output, isError } = await executeTool(
        "process_refund",
        { orderId: "ord_1007", itemIds: ["itm_1007_1"], reason: "grinds unevenly" },
        harness.ctx,
      );

      expect(isError).toBe(false);
      const processed = output as { refundId: string; gatewayRef: string };
      expect(output).toMatchObject({ result: "processed", amountCents: 8999 });

      // Two tool_call steps under the SAME name: a failed first attempt with
      // the error populated, then the successful retry as attempt 2.
      const toolSteps = harness.steps.filter((step) => step.type === "tool_call");
      expect(toolSteps).toHaveLength(2);
      expect(toolSteps[0]).toMatchObject({ name: "process_refund", attempt: 1 });
      expect(toolSteps[0]?.error).toMatch(/gateway unavailable/i);
      expect(toolSteps[0]?.output).toBeUndefined();
      expect(toolSteps[1]).toMatchObject({ name: "process_refund", attempt: 2 });
      expect(toolSteps[1]?.error).toBeUndefined();
      expect(toolSteps[1]?.output).toMatchObject({ result: "processed" });

      // The retry reused the refund id as the idempotency key.
      expect(processed.gatewayRef).toBe(`gw_${processed.refundId}`);
      expect(harness.gateway.executionCount).toBe(1);

      const rows = await refundRowsFor("ord_1007");
      expect(rows).toHaveLength(1);
      expect(rows[0]?.id).toBe(processed.refundId);
      expect(rows[0]?.gatewayRef).toBe(processed.gatewayRef);
    } finally {
      await testDb.db
        .update(appSettings)
        .set({ value: false })
        .where(eq(appSettings.key, "fault_injection"));
    }
  });

  it("zod failure returns invalid_input as an error result, records the step, writes no row", async () => {
    const harness = await createToolHarness(testDb.db, "cus_003");
    const { output, isError } = await executeTool(
      "process_refund",
      {
        orderId: "ord_1010",
        itemIds: ["itm_1010_1"],
        reason: "x",
        amountCents: 999999, // the field that must not exist
      },
      harness.ctx,
    );

    expect(isError).toBe(true);
    expect(output).toMatchObject({ error: "invalid_input" });
    expect(
      (output as { issues: { message: string }[] }).issues.length,
    ).toBeGreaterThan(0);

    expect(harness.steps).toHaveLength(1);
    expect(harness.steps[0]).toMatchObject({ type: "tool_call", name: "process_refund" });
    expect(harness.steps[0]?.error).toMatch(/invalid_input/);

    expect(await refundRowsFor("ord_1010")).toHaveLength(0);
    expect(harness.gateway.executionCount).toBe(0);
  });

  it("an unknown tool name is refused without executing anything", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output, isError } = await executeTool(
      "drop_all_tables",
      {},
      harness.ctx,
    );

    expect(isError).toBe(true);
    expect(output).toMatchObject({ error: "unknown_tool" });
    expect(harness.steps[0]?.error).toMatch(/unknown tool/i);
  });
});

// --- get_policy --------------------------------------------------------------------

describe("get_policy", () => {
  it("returns the rendered policy markdown verbatim", async () => {
    const harness = await createToolHarness(testDb.db, "cus_001");
    const { output, isError } = await executeTool("get_policy", {}, harness.ctx);

    expect(isError).toBe(false);
    expect(output).toEqual({ markdown: renderPolicyMarkdown() });
  });
});

// --- createRunTracer ------------------------------------------------------------------

describe("createRunTracer", () => {
  async function createRun(): Promise<string> {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const runId = newId("run");
    await testDb.db.insert(agentRuns).values({
      id: runId,
      conversationId,
      status: "running",
      model: "claude-sonnet-4-6",
      startedAt: new Date(),
    });
    return runId;
  }

  it("persists steps with strictly increasing seq; a retry is a new row with attempt+1", async () => {
    const runId = await createRun();
    const tracer = createRunTracer(testDb.db, runId);

    await tracer.recordStep({
      type: "llm_call",
      name: "claude-sonnet-4-6",
      input: { iteration: 1 },
      output: { stopReason: "tool_use" },
      inputTokens: 9000,
      outputTokens: 300,
      durationMs: 1200,
      startedAt: new Date(),
    });
    await tracer.recordStep({
      type: "tool_call",
      name: "process_refund",
      attempt: 1,
      input: { orderId: "ord_1001" },
      error: "Payment gateway unavailable (503)",
      durationMs: 40,
      startedAt: new Date(),
    });
    await tracer.recordStep({
      type: "tool_call",
      name: "process_refund",
      attempt: 2,
      input: { orderId: "ord_1001" },
      output: { result: "processed" },
      durationMs: 35,
      startedAt: new Date(),
    });

    const rows = await testDb.db
      .select()
      .from(agentSteps)
      .where(eq(agentSteps.runId, runId))
      .orderBy(asc(agentSteps.seq));

    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0]).toMatchObject({
      type: "llm_call",
      name: "claude-sonnet-4-6",
      attempt: 1, // defaulted
      inputTokens: 9000,
      outputTokens: 300,
      durationMs: 1200,
    });
    expect(rows[1]).toMatchObject({
      type: "tool_call",
      name: "process_refund",
      attempt: 1,
      error: "Payment gateway unavailable (503)",
    });
    expect(rows[1]?.output).toBeNull();
    expect(rows[2]).toMatchObject({ name: "process_refund", attempt: 2, error: null });
    expect(rows[2]?.output).toEqual({ result: "processed" });
  });

  it("finalizeRun writes totals with costUsd at 6 decimals — on completion and on failure", async () => {
    const completedId = await createRun();
    const completedTracer = createRunTracer(testDb.db, completedId);
    await completedTracer.finalizeRun({
      status: "completed",
      inputTokens: 9400,
      outputTokens: 400,
      costUsd: computeCostUsd("claude-sonnet-4-6", 9400, 400),
      durationMs: 2400,
      finishedAt: new Date(),
    });

    const [completed] = await testDb.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, completedId));
    expect(completed).toMatchObject({
      status: "completed",
      inputTokens: 9400,
      outputTokens: 400,
      costUsd: "0.034200", // (9400×$3 + 400×$15) / 1M, fixed 6 decimals
      durationMs: 2400,
      error: null,
    });
    expect(completed?.finishedAt).not.toBeNull();

    const failedId = await createRun();
    const failedTracer = createRunTracer(testDb.db, failedId);
    await failedTracer.finalizeRun({
      status: "failed",
      error: "LLM retries exhausted",
      inputTokens: 1200,
      outputTokens: 0,
      costUsd: computeCostUsd("claude-sonnet-4-6", 1200, 0),
      durationMs: 900,
      finishedAt: new Date(),
    });

    const [failed] = await testDb.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, failedId));
    expect(failed).toMatchObject({
      status: "failed",
      error: "LLM retries exhausted",
      costUsd: "0.003600",
    });
    expect(failed?.finishedAt).not.toBeNull();
  });
});

// --- Refund ledger invariants (whole-table sweep) -----------------------------------
//
// Self-sufficient: drives its OWN mix of flows on orders no other test in
// this file writes to (ord_1030 partial, ord_1028 over-threshold escalation,
// ord_1019 fault-injected retry, a duplicate attempt), then sweeps EVERY
// refunds row in the database — seeded and suite-created alike — and asserts
// the project invariants on each: amount = DB item subtotal (shipping
// excluded), no final-sale item, delivered + inside the window at decision
// time, agent-decided ≤ threshold with >threshold only on the human path,
// and no item locked by two non-rejected rows.

describe("refund ledger invariants", () => {
  it("every refunds row satisfies the money/policy/authority invariants after a full mix of flows", async () => {
    // Partial refund: 3-item cart, camp stove is final sale → 2 items paid.
    const mixed = await createToolHarness(testDb.db, "cus_012");
    const { output: mixedOut } = await executeTool(
      "process_refund",
      {
        orderId: "ord_1030",
        itemIds: ["itm_1030_1", "itm_1030_2", "itm_1030_3"],
        reason: "gear did not survive the first trip",
      },
      mixed.ctx,
    );
    expect(mixedOut).toMatchObject({
      result: "processed",
      amountCents: 15999 + 18999, // jacket + boots; stove (final sale) excluded
      itemIds: ["itm_1030_1", "itm_1030_2"],
    });

    // Over-threshold ($1,200): process refuses without touching the gateway,
    // escalate_to_human writes the pending row.
    const large = await createToolHarness(testDb.db, "cus_011");
    const largeArgs = {
      orderId: "ord_1028",
      itemIds: ["itm_1028_1", "itm_1028_2"],
      reason: "espresso machine leaks from the boiler",
    };
    const { output: refused } = await executeTool("process_refund", largeArgs, large.ctx);
    expect(refused).toEqual({
      result: "requires_escalation",
      refundableCents: 120000,
    });
    const { output: escalatedOut } = await executeTool(
      "escalate_to_human",
      largeArgs,
      large.ctx,
    );
    expect(escalatedOut).toMatchObject({ result: "escalated", amountCents: 120000 });
    expect(large.gateway.executionCount).toBe(0);

    // Fault-injected retry: processed exactly once under the same refund id.
    await testDb.db
      .update(appSettings)
      .set({ value: true })
      .where(eq(appSettings.key, "fault_injection"));
    try {
      const chaos = await createToolHarness(testDb.db, "cus_006");
      const { output: chaosOut } = await executeTool(
        "process_refund",
        { orderId: "ord_1019", itemIds: ["itm_1019_1"], reason: "hub never pairs" },
        chaos.ctx,
      );
      expect(chaosOut).toMatchObject({ result: "processed", amountCents: 3499 });
      expect(chaos.gateway.executionCount).toBe(1);
    } finally {
      await testDb.db
        .update(appSettings)
        .set({ value: false })
        .where(eq(appSettings.key, "fault_injection"));
    }

    // Duplicate attempt against the partial refund: reports the existing row.
    const repeat = await createToolHarness(testDb.db, "cus_012");
    const { output: repeatOut } = await executeTool(
      "process_refund",
      { orderId: "ord_1030", itemIds: ["itm_1030_1"], reason: "asking twice" },
      repeat.ctx,
    );
    expect(repeatOut).toMatchObject({ result: "already_refunded", status: "processed" });

    // The sweep: every row in the table, including everything earlier tests
    // in this file created through the same tools, upholds every invariant.
    const summary = await assertRefundLedgerInvariants(testDb.db);

    // Guaranteed even when this test runs alone: its own two processed rows
    // + the seeded ref_seed_0001, and its own escalated row.
    expect(summary.processed).toBeGreaterThanOrEqual(3);
    expect(summary.escalated).toBeGreaterThanOrEqual(1);
    // T3 has no admin surface: nothing can mint approved/rejected rows.
    expect(summary.approved).toBe(0);
    expect(summary.rejected).toBe(0);
    expect(summary.total).toBe(summary.processed + summary.escalated);
  });
});
