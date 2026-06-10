// ---------------------------------------------------------------------------
// Agent-loop tests — DB-backed against the local compose Postgres, driven by
// the scripted LlmClient (zero network, zero ANTHROPIC_API_KEY). Reseeds via
// runSeed(db) in beforeAll; write tests use disjoint seed orders so a single
// reseed keeps them independent (ord_1001 happy path, ord_1003 fault
// injection, ord_1023 escalation; ord_1016 is read-only).
// ---------------------------------------------------------------------------

import {
  agentRuns,
  agentSteps,
  appSettings,
  messages,
  refunds,
  runSeed,
} from "@loopp/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { replayRunEvents } from "./event-replay";
import type { RunEvent, RunEventBus } from "./events";
import { MockPaymentGateway } from "./gateway";
import {
  LlmCallError,
  MissingApiKeyError,
  createScriptedLlmClient,
  type LlmResponse,
  type LlmToolResultBlock,
  type LlmUsage,
  type ScriptedLlmClient,
  type ScriptedLlmResult,
} from "./llm";
import {
  AgentRunFailedError,
  ConversationNotFoundError,
  MAX_LLM_CALLS_PER_RUN,
  runAgentTurn,
  type AgentDeps,
} from "./loop";
import { computeCostUsd, formatCostUsd } from "./pricing";
import { buildSystemPrompt } from "./system-prompt";
import {
  assertRefundLedgerInvariants,
  connectTestDb,
  createTestConversation,
  type TestDb,
} from "./test-helpers";

const MODEL = "claude-sonnet-4-6";

/** Default per-call usage; 4 calls sum to the Flow A worked example (≈$0.034). */
const USAGE: LlmUsage = { inputTokens: 2350, outputTokens: 100 };

let testDb: TestDb;

beforeAll(async () => {
  testDb = connectTestDb();
  await runSeed(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

afterEach(async () => {
  // Fault injection must never leak into the next test.
  await testDb.db
    .update(appSettings)
    .set({ value: false })
    .where(eq(appSettings.key, "fault_injection"));
});

// --- Script + harness helpers -------------------------------------------------

let toolUseCounter = 0;

function endTurn(text: string, usage: LlmUsage = USAGE): LlmResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage };
}

function toolUse(name: string, input: unknown, usage: LlmUsage = USAGE): LlmResponse {
  toolUseCounter += 1;
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `tu_${toolUseCounter}`, name, input }],
    usage,
  };
}

function retryableLlmError(message: string): LlmCallError {
  return new LlmCallError(message, { retryable: true, status: 529 });
}

interface LoopHarness {
  deps: AgentDeps;
  llm: ScriptedLlmClient;
  gateway: MockPaymentGateway;
  /** Backoff delays requested by the loop, in order. */
  sleeps: number[];
  /** Every RunEvent the loop emitted, in emission order. */
  events: RunEvent[];
}

/**
 * A RunEventBus that records every emit (only the loop's emit path is exercised
 * here — subscribe/events are no-ops). Recording emits directly is timing-free:
 * the loop allocates the runId internally, so there is no window to subscribe
 * before the run starts.
 */
function createRecordingBus(events: RunEvent[]): RunEventBus {
  return {
    emit: (_runId, event) => {
      events.push(event);
    },
    subscribe: () => () => {},
    events: () => {
      throw new Error("recording bus does not implement events()");
    },
  };
}

function buildHarness(script: readonly ScriptedLlmResult[]): LoopHarness {
  const llm = createScriptedLlmClient(script);
  const gateway = new MockPaymentGateway();
  const sleeps: number[] = [];
  const events: RunEvent[] = [];
  const deps: AgentDeps = {
    db: testDb.db,
    getLlm: () => llm,
    model: MODEL,
    gateway,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    events: createRecordingBus(events),
  };
  return { deps, llm, gateway, sleeps, events };
}

async function stepsFor(runId: string) {
  return testDb.db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(asc(agentSteps.seq));
}

async function runRow(runId: string) {
  const rows = await testDb.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function onlyRunFor(conversationId: string) {
  const rows = await testDb.db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.conversationId, conversationId));
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function messagesFor(conversationId: string) {
  return testDb.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
}

async function refundsFor(orderId: string) {
  return testDb.db
    .select()
    .from(refunds)
    .where(eq(refunds.orderId, orderId))
    .orderBy(asc(refunds.createdAt));
}

async function tableCounts() {
  const messageRows = await testDb.db.select({ id: messages.id }).from(messages);
  const runRows = await testDb.db.select({ id: agentRuns.id }).from(agentRuns);
  return { messages: messageRows.length, runs: runRows.length };
}

// --- (a) Happy path: Flow A against ord_1001 ----------------------------------

describe("runAgentTurn happy path (ord_1001)", () => {
  it("processes the refund and persists the complete seq-ordered trace", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const userText = "My coffee set arrived chipped — can I get a refund?";
    const replyText =
      "Your refund of $59.99 for the Ceramic Pour-Over Coffee Set has been processed.";

    const investigate = toolUse(
      "get_order",
      { orderId: "ord_1001" },
      { inputTokens: 2200, outputTokens: 80 },
    );
    const script = [
      investigate,
      toolUse(
        "check_refund_eligibility",
        { orderId: "ord_1001", itemIds: ["itm_1001_1"] },
        { inputTokens: 2300, outputTokens: 90 },
      ),
      toolUse(
        "process_refund",
        { orderId: "ord_1001", itemIds: ["itm_1001_1"], reason: "arrived chipped" },
        { inputTokens: 2400, outputTokens: 110 },
      ),
      endTurn(replyText, { inputTokens: 2500, outputTokens: 120 }),
    ];
    const harness = buildHarness(script);

    const result = await runAgentTurn(harness.deps, conversationId, userText);

    expect(result.reply).toBe(replyText);
    expect(harness.llm.remaining()).toBe(0);

    // Request wiring: system prompt, the six tools, and the persisted user turn.
    const firstRequest = harness.llm.requests[0]!;
    expect(firstRequest.model).toBe(MODEL);
    expect(firstRequest.system).toBe(buildSystemPrompt());
    expect(firstRequest.tools.map((tool) => tool.name)).toEqual([
      "get_customer_context",
      "get_order",
      "check_refund_eligibility",
      "process_refund",
      "escalate_to_human",
      "get_policy",
    ]);
    expect(firstRequest.messages).toEqual([
      { role: "user", content: [{ type: "text", text: userText }] },
    ]);

    // The second request appends the assistant tool_use + a matching tool_result.
    const secondRequest = harness.llm.requests[1]!;
    expect(secondRequest.messages).toHaveLength(3);
    expect(secondRequest.messages[1]).toEqual({
      role: "assistant",
      content: investigate.content,
    });
    const toolResultTurn = secondRequest.messages[2]!;
    expect(toolResultTurn.role).toBe("user");
    const toolResult = toolResultTurn.content[0] as LlmToolResultBlock;
    expect(toolResult.type).toBe("tool_result");
    expect(toolResult.toolUseId).toBe(
      (investigate.content[0] as { id: string }).id,
    );
    expect(toolResult.isError).toBe(false);
    expect(toolResult.content).toContain("itm_1001_1");

    // Refund ledger: amount recomputed server-side from the DB price.
    const refundRows = await refundsFor("ord_1001");
    expect(refundRows).toHaveLength(1);
    const refund = refundRows[0]!;
    expect(refund.amountCents).toBe(5999);
    expect(refund.status).toBe("processed");
    expect(refund.decidedBy).toBe("agent");
    expect(refund.gatewayRef).toBe(`gw_${refund.id}`);
    expect(refund.itemIds).toEqual(["itm_1001_1"]);
    expect(refund.conversationId).toBe(conversationId);
    expect(refund.runId).toBe(result.runId);
    expect(harness.gateway.executionCount).toBe(1);

    // Messages: the user turn plus an assistant reply that matches DB state.
    const rows = await messagesFor(conversationId);
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(rows[0]!.content).toBe(userText);
    expect(rows[1]!.content).toBe(result.reply);
    expect(rows[1]!.runId).toBe(result.runId);

    // Trace: llm_call/tool_call alternation, strictly increasing seq.
    const steps = await stepsFor(result.runId);
    expect(steps.map((step) => step.type)).toEqual([
      "llm_call",
      "tool_call",
      "llm_call",
      "tool_call",
      "llm_call",
      "tool_call",
      "llm_call",
    ]);
    expect(steps.map((step) => step.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(steps.map((step) => step.name)).toEqual([
      MODEL,
      "get_order",
      MODEL,
      "check_refund_eligibility",
      MODEL,
      "process_refund",
      MODEL,
    ]);
    expect(steps.every((step) => step.attempt === 1)).toBe(true);
    for (const step of steps) {
      expect(step.durationMs).not.toBeNull();
      expect(step.error).toBeNull();
      if (step.type === "llm_call") {
        expect(step.inputTokens).toBeGreaterThan(0);
        expect(step.outputTokens).toBeGreaterThan(0);
      }
    }
    expect((steps[0]!.output as { stopReason: string }).stopReason).toBe("tool_use");
    expect((steps[6]!.output as { stopReason: string }).stopReason).toBe("end_turn");
    expect((steps[0]!.input as { iteration: number }).iteration).toBe(1);

    // Run totals: tokens summed over all calls, costUsd at $3/M in + $15/M out.
    const run = await runRow(result.runId);
    const inputSum = 2200 + 2300 + 2400 + 2500;
    const outputSum = 80 + 90 + 110 + 120;
    expect(run.status).toBe("completed");
    expect(run.model).toBe(MODEL);
    expect(run.inputTokens).toBe(inputSum);
    expect(run.outputTokens).toBe(outputSum);
    expect(run.costUsd).toBe(((inputSum * 3 + outputSum * 15) / 1e6).toFixed(6));
    expect(run.costUsd).toBe(formatCostUsd(computeCostUsd(MODEL, inputSum, outputSum)));
    expect(run.costUsd).toBe("0.034200"); // the Flow A worked example
    expect(run.durationMs).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();
    expect(run.error).toBeNull();
  });
});

// --- (b) Final sale: denial leaves no rows -------------------------------------

describe("runAgentTurn final-sale denial (ord_1016)", () => {
  it("writes zero refunds rows and the tool output cites 'final_sale'", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_005");
    const harness = buildHarness([
      toolUse("process_refund", {
        orderId: "ord_1016",
        itemIds: ["itm_1016_1"],
        reason: "changed my mind",
      }),
      endTurn(
        "I'm sorry — the Aviator Sunglasses were a final-sale item, so they aren't eligible for a refund.",
      ),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "I'd like to return my sunglasses",
    );

    expect(await refundsFor("ord_1016")).toHaveLength(0);
    expect(harness.gateway.executionCount).toBe(0);

    const steps = await stepsFor(result.runId);
    const toolStep = steps.find((step) => step.type === "tool_call")!;
    expect(toolStep.name).toBe("process_refund");
    const output = toolStep.output as {
      result: string;
      verdicts: Array<{ itemId: string; eligible: boolean; ruleId?: string }>;
    };
    expect(output.result).toBe("ineligible");
    expect(output.verdicts).toEqual([
      expect.objectContaining({
        itemId: "itm_1016_1",
        eligible: false,
        ruleId: "final_sale",
      }),
    ]);

    // The denial the model saw carries the rule-id citation too.
    const resultBlock = harness.llm.requests[1]!.messages.at(-1)!
      .content[0] as LlmToolResultBlock;
    expect(resultBlock.isError).toBe(false);
    expect(resultBlock.content).toContain("final_sale");

    expect((await runRow(result.runId)).status).toBe("completed");
  });
});

// --- (c) Over-threshold: escalation, never the gateway --------------------------

describe("runAgentTurn escalation (ord_1023, $525)", () => {
  it("creates exactly one escalated row with no gatewayRef and zero gateway executions", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_008");
    const args = {
      orderId: "ord_1023",
      itemIds: ["itm_1023_1"],
      reason: "desk arrived wobbling",
    };
    const harness = buildHarness([
      toolUse("process_refund", args),
      toolUse("escalate_to_human", args),
      endTurn(
        "Because this refund is over $500, I've escalated it to our support team for review.",
      ),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "I want to return my standing desk",
    );

    const refundRows = await refundsFor("ord_1023");
    expect(refundRows).toHaveLength(1);
    const refund = refundRows[0]!;
    expect(refund.status).toBe("escalated");
    expect(refund.decidedBy).toBeNull();
    expect(refund.gatewayRef).toBeNull();
    expect(refund.resolvedAt).toBeNull();
    expect(refund.amountCents).toBe(52500);
    expect(harness.gateway.executionCount).toBe(0);

    const steps = await stepsFor(result.runId);
    const processStep = steps.find((step) => step.name === "process_refund")!;
    expect(processStep.output).toMatchObject({
      result: "requires_escalation",
      refundableCents: 52500,
    });
    const escalateStep = steps.find((step) => step.name === "escalate_to_human")!;
    expect(escalateStep.output).toMatchObject({
      result: "escalated",
      amountCents: 52500,
    });

    expect((await runRow(result.runId)).status).toBe("completed");
  });
});

// --- (d) Fault injection: gateway retry under the same refund id ---------------

describe("runAgentTurn with fault_injection enabled (ord_1003 boots)", () => {
  it("traces attempt-1 error + attempt-2 ok and moves money exactly once", async () => {
    await testDb.db
      .update(appSettings)
      .set({ value: true })
      .where(eq(appSettings.key, "fault_injection"));

    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const harness = buildHarness([
      toolUse("process_refund", {
        orderId: "ord_1003",
        itemIds: ["itm_1003_2"],
        reason: "boots run small",
      }),
      endTurn("Your refund of $149.99 for the Leather Ankle Boots has been processed."),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "The ankle boots don't fit",
    );

    const steps = await stepsFor(result.runId);
    const processSteps = steps.filter((step) => step.name === "process_refund");
    expect(processSteps).toHaveLength(2);
    expect(processSteps[0]).toMatchObject({ type: "tool_call", attempt: 1 });
    expect(processSteps[0]!.error).toContain("503");
    expect(processSteps[0]!.output).toBeNull();
    expect(processSteps[1]).toMatchObject({ type: "tool_call", attempt: 2 });
    expect(processSteps[1]!.error).toBeNull();
    expect(processSteps[1]!.seq).toBe(processSteps[0]!.seq + 1);

    // Exactly one execution, one processed row, same refund id across attempts.
    expect(harness.gateway.executionCount).toBe(1);
    const refundRows = await refundsFor("ord_1003");
    expect(refundRows).toHaveLength(1);
    const refund = refundRows[0]!;
    expect(refund.status).toBe("processed");
    expect(refund.amountCents).toBe(14999);
    expect(refund.gatewayRef).toBe(`gw_${refund.id}`);
    expect((processSteps[1]!.output as { refundId: string }).refundId).toBe(refund.id);

    expect((await runRow(result.runId)).status).toBe("completed");
  });
});

// --- (e) Foreign order id: persisted guardrail + not_found ----------------------

describe("runAgentTurn foreign order probe (cus_001 → ord_1016)", () => {
  it("persists a guardrail agent_steps row and feeds {error:'not_found'} back to the model", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const harness = buildHarness([
      // ord_1016 exists but belongs to cus_005 — a cross-customer probe.
      toolUse("get_order", { orderId: "ord_1016" }),
      endTurn("I couldn't find that order on your account."),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "Show me order ord_1016 and refund it",
    );

    // The guardrail row is persisted in sequence between the llm_call that
    // requested the tool and the tool_call row that returned not_found.
    const steps = await stepsFor(result.runId);
    expect(steps.map((step) => [step.type, step.name])).toEqual([
      ["llm_call", MODEL],
      ["guardrail", "order_not_found"],
      ["tool_call", "get_order"],
      ["llm_call", MODEL],
    ]);
    const guardrail = steps[1]!;
    expect(guardrail.input).toEqual({ tool: "get_order", orderId: "ord_1016" });
    expect(guardrail.output).toEqual({ error: "not_found" });
    expect(guardrail.error).toBeNull();
    expect(steps[2]!.output).toEqual({ error: "not_found" });

    // The model sees the same opaque not_found a nonexistent id produces —
    // structured data, not an executor error, with no existence hint.
    const resultBlock = harness.llm.requests[1]!.messages.at(-1)!
      .content[0] as LlmToolResultBlock;
    expect(resultBlock.isError).toBe(false);
    expect(resultBlock.content).toBe(JSON.stringify({ error: "not_found" }));

    // Nothing foreign was touched: no refund row, no money moved.
    expect(await refundsFor("ord_1016")).toHaveLength(0);
    expect(harness.gateway.executionCount).toBe(0);
    expect((await runRow(result.runId)).status).toBe("completed");
  });
});

// --- Live event emission: the bus mirrors agent_steps 1:1 ----------------------
//
// The loop emits RunEvents from the SAME lifecycle that writes agent_steps:
// run_started right after the run insert, the per-step started/finished/
// guardrail events from the tracer's single recordStep boundary (so deep
// guardrails surface), and run_finished in the finally block. The decisive
// assertion in each case is that the live-emitted stream equals
// replayRunEvents(runId) for the same run — because replay is independently
// verified against the persisted rows (event-replay.test.ts), equality proves
// the live stream and the trace cannot diverge: same order, same seq, same
// attempt numbers, same error/token fields.

describe("runAgentTurn live event emission", () => {
  it("happy path: emitted stream equals replay and brackets the per-step pairs", async () => {
    // ord_1025 (cus_009) is a clean, in-window, eligible order no other write
    // test touches, so process_refund genuinely creates the refund here (rather
    // than short-circuiting to already_refunded against a shared order).
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const replyText =
      "Your refund of $24.99 for the Insulated Water Bottle has been processed.";
    const harness = buildHarness([
      toolUse("get_order", { orderId: "ord_1025" }),
      toolUse("check_refund_eligibility", {
        orderId: "ord_1025",
        itemIds: ["itm_1025_1"],
      }),
      toolUse("process_refund", {
        orderId: "ord_1025",
        itemIds: ["itm_1025_1"],
        reason: "arrived leaking",
      }),
      endTurn(replyText),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "My water bottle arrived leaking — can I get a refund?",
    );

    // 1:1 with the persisted trace: the live stream is exactly what a later
    // reload reconstructs from agent_steps.
    const replay = await replayRunEvents(testDb.db, result.runId);
    expect(harness.events).toEqual(replay);

    // Shape: run_started, then started/finished per step, then run_finished.
    expect(harness.events.map((event) => event.type)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);

    // Brackets: run_started carries seq 0; run_finished carries the final
    // step's seq and status 'completed' with no error.
    expect(harness.events[0]).toEqual({
      type: "run_started",
      runId: result.runId,
      seq: 0,
    });
    const last = harness.events.at(-1)!;
    expect(last.type).toBe("run_finished");
    if (last.type === "run_finished") {
      expect(last.status).toBe("completed");
      expect(last.error).toBeUndefined();
      const steps = await stepsFor(result.runId);
      expect(last.seq).toBe(steps.at(-1)!.seq);
    }

    // seq is non-decreasing across the whole stream (de-dupable vs a replay).
    const seqs = harness.events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
    }

    // The first finished llm_call carries the per-attempt tokens it persisted.
    const llmFinished = harness.events.find(
      (event) => event.type === "llm_call_finished",
    );
    expect(llmFinished).toMatchObject({
      name: MODEL,
      attempt: 1,
      inputTokens: USAGE.inputTokens,
      outputTokens: USAGE.outputTokens,
    });

    // Names line up with the tool calls.
    const toolFinishedNames = harness.events
      .filter((event) => event.type === "tool_call_finished")
      .map((event) => (event as Extract<RunEvent, { type: "tool_call_finished" }>).name);
    expect(toolFinishedNames).toEqual([
      "get_order",
      "check_refund_eligibility",
      "process_refund",
    ]);
  });

  it("gateway retry: a tool_call_finished attempt-1 error precedes the attempt-2 success", async () => {
    await testDb.db
      .update(appSettings)
      .set({ value: true })
      .where(eq(appSettings.key, "fault_injection"));

    // ord_1024 (cus_009) is an in-window, eligible, sub-threshold order that no
    // other write test touches — so the refund actually reaches the gateway and
    // the injected fault forces the exactly-once retry (block (d)'s ord_1003 is
    // already refunded by the time the full file runs, which would short-circuit
    // to already_refunded with no gateway call).
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      toolUse("process_refund", {
        orderId: "ord_1024",
        itemIds: ["itm_1024_1"],
        reason: "phone case cracked",
      }),
      endTurn("Your refund of $19.99 for the Clear MagSafe Phone Case has been processed."),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "My phone case arrived cracked",
    );

    expect(harness.events).toEqual(await replayRunEvents(testDb.db, result.runId));

    // The retried tool surfaces as two finished events: attempt 1 with the
    // gateway error, attempt 2 clean — the live counterpart of the two
    // tool_call rows the fault injection wrote.
    const toolFinished = harness.events.filter(
      (event): event is Extract<RunEvent, { type: "tool_call_finished" }> =>
        event.type === "tool_call_finished" && event.name === "process_refund",
    );
    expect(toolFinished).toHaveLength(2);
    expect(toolFinished[0]!.attempt).toBe(1);
    expect(toolFinished[0]!.error).toContain("503");
    expect(toolFinished[1]!.attempt).toBe(2);
    expect(toolFinished[1]!.error).toBeUndefined();

    // Two started events too, with matching attempts and the same seq as their
    // finished partner.
    const toolStarted = harness.events.filter(
      (event): event is Extract<RunEvent, { type: "tool_call_started" }> =>
        event.type === "tool_call_started" && event.name === "process_refund",
    );
    expect(toolStarted.map((event) => event.attempt)).toEqual([1, 2]);
    expect(toolStarted[0]!.seq).toBe(toolFinished[0]!.seq);
    expect(toolStarted[1]!.seq).toBe(toolFinished[1]!.seq);

    expect(harness.events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
  });

  it("LLM retry: a llm_call_finished error precedes the success, attempts 1 then 2", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      retryableLlmError("Overloaded (529)"),
      endTurn("Happy to help with refunds — which order is this about?"),
    ]);

    const result = await runAgentTurn(harness.deps, conversationId, "hello");

    expect(harness.events).toEqual(await replayRunEvents(testDb.db, result.runId));

    const llmFinished = harness.events.filter(
      (event): event is Extract<RunEvent, { type: "llm_call_finished" }> =>
        event.type === "llm_call_finished",
    );
    expect(llmFinished).toHaveLength(2);
    // Attempt 1 failed: error present, NO token fields.
    expect(llmFinished[0]!.attempt).toBe(1);
    expect(llmFinished[0]!.error).toContain("Overloaded");
    expect(llmFinished[0]!.inputTokens).toBeUndefined();
    expect(llmFinished[0]!.outputTokens).toBeUndefined();
    // Attempt 2 succeeded: tokens present, no error.
    expect(llmFinished[1]!.attempt).toBe(2);
    expect(llmFinished[1]!.error).toBeUndefined();
    expect(llmFinished[1]!.inputTokens).toBe(USAGE.inputTokens);

    expect(harness.events.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
  });

  it("surfaces a deep guardrail (foreign order) as a single guardrail event", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const harness = buildHarness([
      toolUse("get_order", { orderId: "ord_1016" }),
      endTurn("I couldn't find that order on your account."),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "Show me order ord_1016 and refund it",
    );

    expect(harness.events).toEqual(await replayRunEvents(testDb.db, result.runId));

    // The guardrail row written deep in loadScopedOrder surfaces as exactly one
    // guardrail event, in sequence between its llm_call and the tool_call.
    expect(harness.events.map((event) => event.type)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "guardrail",
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);
    const guardrail = harness.events.find((event) => event.type === "guardrail");
    expect(guardrail).toMatchObject({ name: "order_not_found" });
  });

  it("run_finished fires with status 'failed' and the run error on a failed run", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
    ]);

    const error = await runAgentTurn(harness.deps, conversationId, "hello").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentRunFailedError);
    const runId = (error as AgentRunFailedError).runId;

    // Even on failure the live stream matches the replayed one.
    expect(harness.events).toEqual(await replayRunEvents(testDb.db, runId));

    // Three failed attempts → three started/finished pairs, run_finished failed.
    expect(harness.events.map((event) => event.type)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);
    const finished = harness.events.filter(
      (event): event is Extract<RunEvent, { type: "llm_call_finished" }> =>
        event.type === "llm_call_finished",
    );
    expect(finished.map((event) => event.attempt)).toEqual([1, 2, 3]);

    const last = harness.events.at(-1)!;
    expect(last.type).toBe("run_finished");
    if (last.type === "run_finished") {
      expect(last.status).toBe("failed");
      expect(last.error).toContain("overloaded_error");
    }
  });

  it("omits the bus entirely without affecting the run (optional dep)", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    // No events bus on deps — the keyless / harness-omits-bus path.
    const deps: AgentDeps = {
      db: testDb.db,
      getLlm: () => createScriptedLlmClient([endTurn("Hi! How can I help?")]),
      model: MODEL,
      gateway: new MockPaymentGateway(),
      sleep: async () => {},
    };

    const result = await runAgentTurn(deps, conversationId, "hello");
    expect(result.reply).toBe("Hi! How can I help?");
    expect((await runRow(result.runId)).status).toBe("completed");

    // The trace is still complete — replay reconstructs a full stream from it
    // even though nothing was emitted live.
    const replay = await replayRunEvents(testDb.db, result.runId);
    expect(replay[0]).toMatchObject({ type: "run_started" });
    expect(replay.at(-1)).toMatchObject({ type: "run_finished", status: "completed" });
  });
});

// --- LLM retry: per-attempt rows + backoff ----------------------------------

describe("runAgentTurn LLM retries", () => {
  it("retries a retryable error: attempt-1 error row, attempt-2 ok, backoff invoked", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      retryableLlmError("Overloaded (529)"),
      endTurn("Happy to help with refunds — which order is this about?"),
    ]);

    const result = await runAgentTurn(harness.deps, conversationId, "hello");

    const steps = await stepsFor(result.runId);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ type: "llm_call", name: MODEL, attempt: 1 });
    expect(steps[0]!.error).toContain("Overloaded");
    expect(steps[0]!.inputTokens).toBeNull();
    expect(steps[0]!.outputTokens).toBeNull();
    expect(steps[1]).toMatchObject({ type: "llm_call", name: MODEL, attempt: 2 });
    expect(steps[1]!.error).toBeNull();
    expect(harness.sleeps).toEqual([500]);

    // Failed attempts contribute no tokens; the success does.
    const run = await runRow(result.runId);
    expect(run.status).toBe("completed");
    expect(run.inputTokens).toBe(USAGE.inputTokens);
    expect(run.outputTokens).toBe(USAGE.outputTokens);
    expect((await messagesFor(conversationId)).map((row) => row.role)).toEqual([
      "user",
      "assistant",
    ]);
  });

  it("finalizes the run as failed after three retryable failures — totals written, no assistant message", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
    ]);

    const error = await runAgentTurn(harness.deps, conversationId, "hello").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentRunFailedError);

    const run = await onlyRunFor(conversationId);
    expect((error as AgentRunFailedError).runId).toBe(run.id);
    expect(run.status).toBe("failed");
    expect(run.error).toContain("overloaded_error");
    expect(run.inputTokens).toBe(0);
    expect(run.outputTokens).toBe(0);
    expect(run.costUsd).toBe("0.000000");
    expect(run.durationMs).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();

    const steps = await stepsFor(run.id);
    expect(steps.map((step) => [step.type, step.attempt])).toEqual([
      ["llm_call", 1],
      ["llm_call", 2],
      ["llm_call", 3],
    ]);
    expect(steps.every((step) => step.error !== null)).toBe(true);
    expect(harness.sleeps).toEqual([500, 1000]); // exponential backoff

    // Say only what happened: no assistant message for a failed run.
    expect((await messagesFor(conversationId)).map((row) => row.role)).toEqual([
      "user",
    ]);
  });

  it("does not retry a non-retryable error", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      new LlmCallError("Invalid request (400)", { retryable: false, status: 400 }),
    ]);

    await expect(
      runAgentTurn(harness.deps, conversationId, "hello"),
    ).rejects.toBeInstanceOf(AgentRunFailedError);

    const run = await onlyRunFor(conversationId);
    expect(run.status).toBe("failed");
    const steps = await stepsFor(run.id);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ type: "llm_call", attempt: 1 });
    expect(harness.sleeps).toEqual([]);
  });
});

// --- Missing key / unknown conversation: zero DB writes ---------------------

describe("runAgentTurn pre-write failures", () => {
  it("MissingApiKeyError from getLlm propagates before any DB write", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_010");
    const before = await tableCounts();

    const deps: AgentDeps = {
      db: testDb.db,
      getLlm: () => {
        throw new MissingApiKeyError();
      },
      model: MODEL,
      gateway: new MockPaymentGateway(),
    };

    await expect(
      runAgentTurn(deps, conversationId, "hello"),
    ).rejects.toBeInstanceOf(MissingApiKeyError);

    expect(await tableCounts()).toEqual(before);
  });

  it("throws ConversationNotFoundError for an unknown conversation, writing nothing", async () => {
    const before = await tableCounts();
    const harness = buildHarness([endTurn("never reached")]);

    await expect(
      runAgentTurn(harness.deps, "conv_does_not_exist", "hello"),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(await tableCounts()).toEqual(before);
    expect(harness.llm.requests).toHaveLength(0);
  });
});

// --- Iteration cap + protocol guard ------------------------------------------

describe("runAgentTurn loop guards", () => {
  it(`fails the run after ${MAX_LLM_CALLS_PER_RUN} LLM calls without end_turn`, async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const script = Array.from({ length: MAX_LLM_CALLS_PER_RUN }, () =>
      toolUse("get_policy", {}),
    );
    const harness = buildHarness(script);

    const error = await runAgentTurn(
      harness.deps,
      conversationId,
      "loop forever",
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentRunFailedError);
    expect((error as Error).message).toContain(`${MAX_LLM_CALLS_PER_RUN}`);

    // The guard stopped the loop — not script exhaustion.
    expect(harness.llm.remaining()).toBe(0);

    const run = await onlyRunFor(conversationId);
    expect(run.status).toBe("failed");
    // Totals still written on failure: 10 successful calls' tokens.
    expect(run.inputTokens).toBe(USAGE.inputTokens * MAX_LLM_CALLS_PER_RUN);
    expect(run.outputTokens).toBe(USAGE.outputTokens * MAX_LLM_CALLS_PER_RUN);

    const steps = await stepsFor(run.id);
    expect(steps.filter((step) => step.type === "llm_call")).toHaveLength(
      MAX_LLM_CALLS_PER_RUN,
    );
    expect(steps.filter((step) => step.type === "tool_call")).toHaveLength(
      MAX_LLM_CALLS_PER_RUN,
    );
    expect((await messagesFor(conversationId)).map((row) => row.role)).toEqual([
      "user",
    ]);
  });

  it("fails the run on an unexpected stop reason instead of inventing a reply", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    const harness = buildHarness([
      {
        stopReason: "max_tokens",
        content: [{ type: "text", text: "truncated mid-sentence" }],
        usage: USAGE,
      },
    ]);

    const error = await runAgentTurn(harness.deps, conversationId, "hello").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentRunFailedError);
    expect((error as Error).message).toContain("max_tokens");

    expect((await onlyRunFor(conversationId)).status).toBe("failed");
    expect((await messagesFor(conversationId)).map((row) => row.role)).toEqual([
      "user",
    ]);
  });
});

// --- Loop wiring extras -----------------------------------------------------------

describe("runAgentTurn transcript handling", () => {
  it("replays prior turns as text only — intra-turn tool blocks are not re-sent", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_015");

    const firstTurn = buildHarness([
      toolUse("get_policy", {}),
      endTurn("Here's the gist of our refund policy."),
    ]);
    await runAgentTurn(firstTurn.deps, conversationId, "What's your refund policy?");

    const secondTurn = buildHarness([endTurn("Anything else I can help with?")]);
    await runAgentTurn(secondTurn.deps, conversationId, "Thanks, that's all!");

    const request = secondTurn.llm.requests[0]!;
    expect(request.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    for (const message of request.messages) {
      for (const block of message.content) {
        expect(block.type).toBe("text");
      }
    }
    expect(request.messages[1]!.content).toEqual([
      { type: "text", text: "Here's the gist of our refund policy." },
    ]);
  });

  it("executes every tool_use block of one response and returns all results in one turn", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_015");
    const parallel: LlmResponse = {
      stopReason: "tool_use",
      content: [
        { type: "tool_use", id: "tu_par_1", name: "get_customer_context", input: {} },
        { type: "tool_use", id: "tu_par_2", name: "get_policy", input: {} },
      ],
      usage: USAGE,
    };
    const harness = buildHarness([parallel, endTurn("Here's what I found.")]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "Who am I and what's the policy?",
    );

    const steps = await stepsFor(result.runId);
    expect(steps.map((step) => step.name)).toEqual([
      MODEL,
      "get_customer_context",
      "get_policy",
      MODEL,
    ]);

    const resultsTurn = harness.llm.requests[1]!.messages.at(-1)!;
    expect(resultsTurn.role).toBe("user");
    const blocks = resultsTurn.content as LlmToolResultBlock[];
    expect(blocks.map((block) => [block.type, block.toolUseId])).toEqual([
      ["tool_result", "tu_par_1"],
      ["tool_result", "tu_par_2"],
    ]);
  });

  it("feeds zod-rejected model input back as an isError tool_result and the run continues", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_015");
    const harness = buildHarness([
      // itemIds violates min(1) — executeTool reports invalid_input, no throw.
      toolUse("process_refund", { orderId: "ord_1001", itemIds: [], reason: "x" }),
      endTurn("Could you tell me which item you'd like refunded?"),
    ]);

    const result = await runAgentTurn(
      harness.deps,
      conversationId,
      "Refund my order",
    );

    const resultBlock = harness.llm.requests[1]!.messages.at(-1)!
      .content[0] as LlmToolResultBlock;
    expect(resultBlock.isError).toBe(true);
    expect(resultBlock.content).toContain("invalid_input");

    expect((await runRow(result.runId)).status).toBe("completed");
    expect(harness.gateway.executionCount).toBe(0);
  });
});

// --- Ledger invariants over everything the loop wrote ----------------------------
//
// Declared last so a full-file run sweeps the rows the scripted turns above
// created (ord_1001 processed, ord_1003 fault-injected, ord_1023 escalated)
// alongside the seed. Asserts the same whole-table invariants as the tool
// suite: amounts recomputed from DB prices, policy honored at decision time,
// the authority boundary on >threshold rows, one non-rejected refund per item.

describe("refund ledger invariants after loop-driven turns", () => {
  it("every refunds row written through runAgentTurn satisfies the project invariants", async () => {
    const summary = await assertRefundLedgerInvariants(testDb.db);

    // The seed alone guarantees one processed row; a full-file run adds the
    // loop-created processed and escalated rows on top.
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    // T3 exposes no admin surface — the loop can never mint these statuses.
    expect(summary.approved).toBe(0);
    expect(summary.rejected).toBe(0);
  });
});
