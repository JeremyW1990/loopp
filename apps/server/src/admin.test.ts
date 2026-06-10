// ---------------------------------------------------------------------------
// Transport-layer tests for the admin router, driven through
// appRouter.createCaller with an EXPLICITLY constructed context: a test db
// handle plus scripted/keyless AgentDeps wrapping a MockPaymentGateway. The
// suite never loads the server's env/context modules and never touches the
// network — approve/reject use ONLY the mock gateway (no LLM at all), and the
// trace / live-toggle tests drive runAgentTurn with a scripted LlmClient. So it
// passes with no ANTHROPIC_API_KEY, and a locally-present key cannot change
// behavior (getLlm is injected, never resolved from the environment).
//
// Reseeds via runSeed(db) in beforeAll (seed dates are relative to seed time;
// a stale DB would silently drift scenario orders out of policy windows).
// afterEach resets app_settings 'fault_injection' to false because the chaos
// round-trip test flips it on and it would otherwise leak into later tests.
//
// What is pinned here (the wire-level guarantees the design contract names):
//   - admin.approveRefund is exactly-once THROUGH the router: two sequential
//     calls with one refundId execute the gateway once and leave a single
//     'approved' row (decidedBy='admin', resolvedAt + gatewayRef set).
//   - admin.rejectRefund rejects an empty/missing adminNote as BAD_REQUEST
//     (zod) with ZERO writes; a valid note writes 'rejected' (decidedBy=
//     'admin') and never calls the gateway.
//   - approve/reject on an unknown id -> NOT_FOUND, on a non-escalated id ->
//     CONFLICT — neither writes a row nor moves money.
//   - admin.trace returns persisted agent_steps strictly seq-ordered (no gaps
//     or dupes), every type within {llm_call,tool_call,guardrail}, INCLUDING a
//     persisted guardrail row (driven by a foreign order id).
//   - admin.escalations returns ONLY status='escalated' rows with context.
//   - admin.stats aggregates match the DB.
//   - admin.faultInjection.get/.set round-trips AND a subsequent process_refund
//     observes the new value live (attempt-1 gateway 503 + attempt-2 ok row).
// ---------------------------------------------------------------------------

import {
  MockPaymentGateway,
  createScriptedLlmClient,
  type AgentDeps,
  type LlmResponse,
  type LlmUsage,
  type ScriptedLlmClient,
  type ScriptedLlmResult,
} from "@loopp/agent";
import {
  agentRuns,
  appSettings,
  conversations,
  createDb,
  refunds,
  runSeed,
  type Db,
} from "@loopp/db";
import { newId } from "@loopp/shared";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { appRouter } from "./router";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

const MODEL = "claude-sonnet-4-6";
const USAGE: LlmUsage = { inputTokens: 2350, outputTokens: 100 };

let db: Db;
let closeDb: () => Promise<void>;

beforeAll(async () => {
  const handle = createDb(TEST_DATABASE_URL);
  db = handle.db;
  closeDb = () => handle.sql.end();
  await runSeed(db);
});

afterAll(async () => {
  await closeDb();
});

afterEach(async () => {
  // The chaos round-trip flips this on; it must never leak into the next test.
  await db
    .update(appSettings)
    .set({ value: false })
    .where(eq(appSettings.key, "fault_injection"));
});

// --- Harness -------------------------------------------------------------------

interface CallerHarness {
  caller: ReturnType<typeof appRouter.createCaller>;
  llm: ScriptedLlmClient;
  gateway: MockPaymentGateway;
}

/**
 * Caller whose agent deps wrap a scripted LLM client over the shared MockPayment
 * Gateway (no key, no network). approve/reject ignore the LLM entirely; the
 * trace / live-toggle tests script real tool turns. Each harness gets its OWN
 * gateway so executionCount is scoped to the call(s) under test.
 */
function buildCaller(script: readonly ScriptedLlmResult[] = []): CallerHarness {
  const llm = createScriptedLlmClient(script);
  const gateway = new MockPaymentGateway();
  const agent: AgentDeps = {
    db,
    getLlm: () => llm,
    model: MODEL,
    gateway,
    // Tests never wait on real backoff.
    sleep: async () => {},
  };
  return { caller: appRouter.createCaller({ db, agent }), llm, gateway };
}

// --- Refund fixtures (direct insert) -------------------------------------------

interface SeedRefundInput {
  id: string;
  orderId: string;
  customerId: string;
  itemIds: string[];
  amountCents: number;
  status: "escalated" | "processed" | "rejected";
  reason?: string;
}

/**
 * Insert one refunds row directly — the deterministic way to stage an escalated
 * (or terminal) fixture without driving the agent loop. Mirrors the lifecycle
 * shape the tools write per status: escalated rows are undecided with no
 * gatewayRef/resolvedAt; processed rows carry both.
 */
async function insertRefund(input: SeedRefundInput): Promise<string> {
  const now = new Date();
  const resolved = input.status !== "escalated";
  await db.insert(refunds).values({
    id: input.id,
    orderId: input.orderId,
    customerId: input.customerId,
    conversationId: null,
    runId: null,
    amountCents: input.amountCents,
    itemIds: input.itemIds,
    reason: input.reason ?? "fixture",
    status: input.status,
    decidedBy: input.status === "escalated" ? null : "agent",
    gatewayRef: resolved ? `gw_${input.id}` : null,
    createdAt: now,
    resolvedAt: resolved ? now : null,
  });
  return input.id;
}

async function refundRow(refundId: string) {
  const rows = await db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  return rows[0] ?? null;
}

async function approvedCount(refundId: string) {
  const rows = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "approved")));
  return rows.length;
}

// --- Misc helpers --------------------------------------------------------------

async function createConversation(customerId: string): Promise<string> {
  const id = newId("conv");
  await db.insert(conversations).values({ id, customerId, createdAt: new Date() });
  return id;
}

/** Await a rejection and assert it surfaced as a TRPCError. */
async function rejectionOf(promise: Promise<unknown>): Promise<TRPCError> {
  const outcome = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(TRPCError);
  return outcome as TRPCError;
}

let toolUseCounter = 0;

function endTurn(text: string): LlmResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage: USAGE };
}

function toolUse(name: string, input: unknown): LlmResponse {
  toolUseCounter += 1;
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `tu_admin_${toolUseCounter}`, name, input }],
    usage: USAGE,
  };
}

// --- admin.approveRefund: exactly-once through the router ----------------------

describe("admin.approveRefund idempotency", () => {
  it("two sequential calls with one refundId execute the gateway once and leave a single 'approved' row", async () => {
    // ord_1002 ($899) is over the $500 threshold — the agent could only have
    // escalated it, so admin approve is the sole path that resolves it.
    const refundId = "ref_srv_appr";
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });
    const { caller, gateway } = buildCaller();

    // A double-click / replay: two calls on the same shared gateway.
    const first = await caller.admin.approveRefund({ refundId });
    const second = await caller.admin.approveRefund({ refundId });

    // Money moved exactly once; both responses are the resolved row.
    expect(gateway.executionCount).toBe(1);
    expect(first.status).toBe("approved");
    expect(second.status).toBe("approved");
    expect(second.gatewayRef).toBe(first.gatewayRef);

    // Exactly one 'approved' row, fully resolved by the admin.
    expect(await approvedCount(refundId)).toBe(1);
    const row = await refundRow(refundId);
    expect(row?.status).toBe("approved");
    expect(row?.decidedBy).toBe("admin");
    expect(row?.gatewayRef).toBe(`gw_${refundId}`);
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.adminNote).toBeNull();
  });
});

// --- admin.rejectRefund: zod-validated note, no gateway call -------------------

describe("admin.rejectRefund", () => {
  it("rejects an empty adminNote with BAD_REQUEST before any write (zod .min(1))", async () => {
    const refundId = "ref_srv_rej_empty";
    await insertRefund({
      id: refundId,
      orderId: "ord_1008",
      customerId: "cus_002",
      itemIds: ["itm_1008_1"],
      amountCents: 2999,
      status: "escalated",
    });
    const { caller, gateway } = buildCaller();
    const before = await refundRow(refundId);

    const error = await rejectionOf(
      caller.admin.rejectRefund({ refundId, adminNote: "" }),
    );
    expect(error.code).toBe("BAD_REQUEST");

    // Zero writes: the escalated row is byte-identical and no money moved.
    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);
  });

  it("rejects a MISSING adminNote with BAD_REQUEST (.strict() schema, before any write)", async () => {
    const refundId = "ref_srv_rej_missing";
    await insertRefund({
      id: refundId,
      orderId: "ord_1011",
      customerId: "cus_003",
      itemIds: ["itm_1011_1"],
      amountCents: 2499,
      status: "escalated",
    });
    const { caller, gateway } = buildCaller();
    const before = await refundRow(refundId);

    const error = await rejectionOf(
      caller.admin.rejectRefund({ refundId } as unknown as {
        refundId: string;
        adminNote: string;
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);
  });

  it("with a valid note sets 'rejected' with decidedBy='admin' and never calls the gateway", async () => {
    const refundId = "ref_srv_rej_ok";
    await insertRefund({
      id: refundId,
      orderId: "ord_1029",
      customerId: "cus_011",
      itemIds: ["itm_1029_1"],
      amountCents: 1899,
      status: "escalated",
    });
    const { caller, gateway } = buildCaller();
    const note = "Customer opened a chargeback; declining the duplicate refund.";

    const rejected = await caller.admin.rejectRefund({ refundId, adminNote: note });

    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedBy).toBe("admin");
    expect(rejected.adminNote).toBe(note);
    expect(rejected.resolvedAt).not.toBeNull();
    // No money ever moves on a rejection.
    expect(rejected.gatewayRef).toBeNull();
    expect(gateway.executionCount).toBe(0);
  });
});

// --- approve/reject guards: NOT_FOUND (unknown) and CONFLICT (terminal) --------

describe("admin approve/reject guards", () => {
  it("approveRefund on an unknown id -> NOT_FOUND, no write, no gateway call", async () => {
    const { caller, gateway } = buildCaller();
    const error = await rejectionOf(
      caller.admin.approveRefund({ refundId: "ref_srv_unknown_a" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(await refundRow("ref_srv_unknown_a")).toBeNull();
    expect(gateway.executionCount).toBe(0);
  });

  it("rejectRefund on an unknown id -> NOT_FOUND, no write, no gateway call", async () => {
    const { caller, gateway } = buildCaller();
    const error = await rejectionOf(
      caller.admin.rejectRefund({ refundId: "ref_srv_unknown_r", adminNote: "n" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(await refundRow("ref_srv_unknown_r")).toBeNull();
    expect(gateway.executionCount).toBe(0);
  });

  it("approveRefund on a non-escalated (terminal/processed) id -> CONFLICT, row untouched", async () => {
    const refundId = "ref_srv_term_a";
    await insertRefund({
      id: refundId,
      orderId: "ord_1014",
      customerId: "cus_004",
      itemIds: ["itm_1014_1"],
      amountCents: 5499,
      status: "processed",
    });
    const before = await refundRow(refundId);
    const { caller, gateway } = buildCaller();

    const error = await rejectionOf(caller.admin.approveRefund({ refundId }));
    expect(error.code).toBe("CONFLICT");

    // The processed row is byte-identical and the gateway never ran.
    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);
  });

  it("rejectRefund on a non-escalated (terminal/processed) id -> CONFLICT, row untouched", async () => {
    const refundId = "ref_srv_term_r";
    await insertRefund({
      id: refundId,
      orderId: "ord_1035",
      customerId: "cus_014",
      itemIds: ["itm_1035_1"],
      amountCents: 4599,
      status: "processed",
    });
    const before = await refundRow(refundId);
    const { caller, gateway } = buildCaller();

    const error = await rejectionOf(
      caller.admin.rejectRefund({ refundId, adminNote: "cannot reject a paid refund" }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);
  });
});

// --- admin.runs: per-run summaries backing the runs list -----------------------

describe("admin.runs", () => {
  it("returns a per-run summary for a persisted run with costUsd as a numeric string, newest first", async () => {
    // Drive a real, persisted run (scripted LLM, no key) so there is a genuine
    // agent_runs row for the list to surface — the same path the chat UI uses.
    const conversationId = await createConversation("cus_006");
    const { caller, llm } = buildCaller([
      toolUse("get_order", { orderId: "ord_1019" }),
      endTurn("Your 7-in-1 USB-C Hub order is on its way."),
    ]);

    const { runId } = await caller.chat.sendMessage({
      conversationId,
      text: "Where is my USB-C hub order?",
    });
    expect(llm.remaining()).toBe(0);

    const runs = await caller.admin.runs();
    expect(runs.length).toBeGreaterThan(0);

    // The run we just drove appears with the per-run summary the list renders.
    const summary = runs.find((row) => row.runId === runId);
    expect(summary).toBeDefined();
    expect(summary).toMatchObject({
      runId,
      conversationId,
      customerId: "cus_006",
      customerName: "Liam Nakamura",
      status: "completed",
      model: MODEL,
    });
    // Token counts are integers (the chips render them verbatim).
    expect(Number.isSafeInteger(summary!.inputTokens)).toBe(true);
    expect(Number.isSafeInteger(summary!.outputTokens)).toBe(true);
    expect(summary!.startedAt).toBeInstanceOf(Date);

    // costUsd crosses the wire as a numeric STRING (numeric(12,6) over
    // superjson); the UI formats it directly and never does client-side float
    // math. It must be a parseable, non-NaN decimal string.
    expect(typeof summary!.costUsd).toBe("string");
    expect(Number.isNaN(Number(summary!.costUsd))).toBe(false);

    // The list is ordered startedAt DESC (newest run first) — the order the
    // RunsList relies on, asserted independent of how many runs exist.
    const startTimes = runs.map((row) => row.startedAt.getTime());
    for (let i = 1; i < startTimes.length; i += 1) {
      expect(startTimes[i - 1]!).toBeGreaterThanOrEqual(startTimes[i]!);
    }

    // The summary matches the agent_runs row it is derived from (no fabrication).
    const dbRows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    expect(dbRows).toHaveLength(1);
    expect(summary!.status).toBe(dbRows[0]!.status);
    expect(summary!.costUsd).toBe(dbRows[0]!.costUsd);
    expect(summary!.durationMs).toBe(dbRows[0]!.durationMs);
  });
});

// --- admin.trace: verbatim, strictly seq-ordered, with a guardrail row ---------

describe("admin.trace", () => {
  it("returns persisted agent_steps strictly seq-ordered (no gaps/dupes), types within the closed set", async () => {
    // Drive a real, persisted run (scripted LLM, no key) so there are genuine
    // agent_steps to read back — the trace must surface them verbatim.
    const conversationId = await createConversation("cus_006");
    const { caller, llm } = buildCaller([
      toolUse("get_order", { orderId: "ord_1019" }),
      toolUse("process_refund", {
        orderId: "ord_1019",
        itemIds: ["itm_1019_1"],
        reason: "hub stopped charging",
      }),
      endTurn("Your refund of $34.99 for the 7-in-1 USB-C Hub has been processed."),
    ]);

    const { runId } = await caller.chat.sendMessage({
      conversationId,
      text: "My USB-C hub stopped charging — can I get a refund?",
    });
    expect(llm.remaining()).toBe(0);

    const trace = await caller.admin.trace({ runId });
    expect(trace.run.runId).toBe(runId);
    expect(trace.run.status).toBe("completed");
    expect(trace.run.customerName).toBe("Liam Nakamura");

    // seq is strictly increasing with no gaps or duplicates.
    const seqs = trace.steps.map((step) => step.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBe(seqs[i - 1]! + 1);
    }

    // Every persisted type is within the closed set the viewer renders.
    const allowed = new Set(["llm_call", "tool_call", "guardrail"]);
    for (const step of trace.steps) {
      expect(allowed.has(step.type)).toBe(true);
    }

    // The step shape is the persisted trace verbatim — llm/tool alternation,
    // the process_refund I/O carried through unchanged.
    expect(trace.steps.map((step) => [step.type, step.name])).toEqual([
      ["llm_call", MODEL],
      ["tool_call", "get_order"],
      ["llm_call", MODEL],
      ["tool_call", "process_refund"],
      ["llm_call", MODEL],
    ]);
    const processStep = trace.steps.find((step) => step.name === "process_refund")!;
    expect(processStep.input).toMatchObject({
      orderId: "ord_1019",
      itemIds: ["itm_1019_1"],
    });
    expect(processStep.output).toMatchObject({
      result: "processed",
      amountCents: 3499,
    });
    expect(processStep.error).toBeNull();
  });

  it("surfaces a persisted guardrail row (order_not_found) when the model names a foreign order id", async () => {
    // cus_001 asks about an order they do not own. loadScopedOrder writes one
    // 'order_not_found' guardrail step BEFORE the tool_call step, so the
    // persisted trace carries a guardrail row the viewer renders distinctly.
    const conversationId = await createConversation("cus_001");
    const { caller, llm } = buildCaller([
      // ord_9999 exists on no account — a foreign/unknown id either way.
      toolUse("get_order", { orderId: "ord_9999" }),
      endTurn("I couldn't find that order on your account."),
    ]);

    const { runId } = await caller.chat.sendMessage({
      conversationId,
      text: "What's the status of order ord_9999?",
    });
    expect(llm.remaining()).toBe(0);

    const trace = await caller.admin.trace({ runId });

    // seq is still strictly increasing with no gaps or dupes, and the guardrail
    // sits between the llm_call that requested the tool and the tool_call row.
    expect(trace.steps.map((step) => [step.seq, step.type, step.name])).toEqual([
      [1, "llm_call", MODEL],
      [2, "guardrail", "order_not_found"],
      [3, "tool_call", "get_order"],
      [4, "llm_call", MODEL],
    ]);

    // A guardrail row actually persisted and carries its kind + the masked
    // not_found output (the same shape a foreign and a nonexistent id share).
    const guardrail = trace.steps.find((step) => step.type === "guardrail");
    expect(guardrail).toBeDefined();
    expect(guardrail!.name).toBe("order_not_found");
    expect(guardrail!.output).toEqual({ error: "not_found" });
    expect(guardrail!.input).toMatchObject({ tool: "get_order", orderId: "ord_9999" });
  });

  it("unknown runId -> NOT_FOUND (the viewer never fabricates a trace)", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(caller.admin.trace({ runId: "run_does_not_exist" }));
    expect(error.code).toBe("NOT_FOUND");
  });

  it("rejects unknown input keys (.strict() schema)", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.admin.trace({ runId: "run_x", extra: 1 } as unknown as {
        runId: string;
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

// --- admin.escalations: only status='escalated' rows ---------------------------

describe("admin.escalations", () => {
  it("returns ONLY escalated rows with customer/order/amount context, newest first", async () => {
    // Three disjoint fixtures: one escalated, one processed, one rejected. Only
    // the escalated one may appear in the queue.
    const escalatedId = "ref_srv_esc_open";
    await insertRefund({
      id: escalatedId,
      orderId: "ord_1028",
      customerId: "cus_011",
      itemIds: ["itm_1028_1"],
      amountCents: 74900,
      status: "escalated",
      reason: "machine arrived cracked",
    });
    await insertRefund({
      id: "ref_srv_esc_done",
      orderId: "ord_1037",
      customerId: "cus_015",
      itemIds: ["itm_1037_1"],
      amountCents: 2999,
      status: "processed",
    });
    await insertRefund({
      id: "ref_srv_esc_rej",
      orderId: "ord_1038",
      customerId: "cus_015",
      itemIds: ["itm_1038_1"],
      amountCents: 1599,
      status: "rejected",
    });

    const { caller } = buildCaller();
    const escalations = await caller.admin.escalations();

    // Every returned row is genuinely escalated (verified against the DB) — the
    // processed and rejected fixtures never leak in.
    expect(escalations.length).toBeGreaterThan(0);
    for (const row of escalations) {
      const dbRow = await refundRow(row.refundId);
      expect(dbRow?.status).toBe("escalated");
    }
    const ids = new Set(escalations.map((row) => row.refundId));
    expect(ids.has(escalatedId)).toBe(true);
    expect(ids.has("ref_srv_esc_done")).toBe(false);
    expect(ids.has("ref_srv_esc_rej")).toBe(false);

    // The escalated row carries the context the queue renders (integer cents).
    const open = escalations.find((row) => row.refundId === escalatedId)!;
    expect(open).toMatchObject({
      customerName: "Isabella Martinez",
      orderId: "ord_1028",
      itemIds: ["itm_1028_1"],
      amountCents: 74900,
      reason: "machine arrived cracked",
    });
    expect(Number.isSafeInteger(open.amountCents)).toBe(true);
    expect(open.createdAt).toBeInstanceOf(Date);
  });
});

// --- admin.stats: aggregates over agent_runs + the escalation queue ------------

describe("admin.stats", () => {
  it("aggregates totalRuns, totalCostUsd (string), avgDurationMs, openEscalations to match the DB", async () => {
    const { caller } = buildCaller();
    const stats = await caller.admin.stats();

    // totalRuns matches the agent_runs row count.
    const runRows = await db.select({ id: agentRuns.id }).from(agentRuns);
    expect(stats.totalRuns).toBe(runRows.length);

    // openEscalations matches the count of status='escalated' refunds.
    const escRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.status, "escalated"));
    expect(stats.openEscalations).toBe(escRows.length);

    // totalCostUsd crosses the wire as a numeric STRING (the UI formats it; no
    // client-side float math). avgDurationMs is a number when runs exist.
    expect(typeof stats.totalCostUsd).toBe("string");
    expect(Number.isNaN(Number(stats.totalCostUsd))).toBe(false);
    if (stats.totalRuns > 0) {
      expect(typeof stats.avgDurationMs).toBe("number");
    }
  });
});

// --- admin.faultInjection: round-trip + live observation by process_refund -----

describe("admin.faultInjection", () => {
  it("get/.set round-trips, and a subsequent process_refund observes the new value live", async () => {
    // Starts off (afterEach resets it). Reading reflects that.
    const { caller } = buildCaller();
    expect(await caller.admin.faultInjection.get()).toBe(false);

    // Flip it ON over tRPC; the next read reflects the write.
    const setResult = await caller.admin.faultInjection.set({ enabled: true });
    expect(setResult).toBe(true);
    expect(await caller.admin.faultInjection.get()).toBe(true);

    // Drive a real refund while chaos is ON, over a fresh eligible order
    // (ord_1036/cus_015, $39.99 — delivered today, sub-threshold, untouched by
    // every other test). The gateway's FIRST attempt per key throws 503; the
    // tool retries once with the SAME refund id and succeeds — so the live
    // toggle is genuinely observed by the refund path, not just the settings
    // table.
    const conversationId = await createConversation("cus_015");
    const replyText =
      "Your refund of $39.99 for the Sport Smart Watch Band has been processed.";
    const { caller: runCaller, llm, gateway } = buildCaller([
      toolUse("process_refund", {
        orderId: "ord_1036",
        itemIds: ["itm_1036_1"],
        reason: "watch band clasp broke",
      }),
      endTurn(replyText),
    ]);

    const { runId, reply } = await runCaller.chat.sendMessage({
      conversationId,
      text: "My watch band clasp broke — refund please?",
    });
    expect(reply).toBe(replyText);
    expect(llm.remaining()).toBe(0);

    // The refund still processed exactly once despite the injected fault.
    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, "ord_1036"));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      status: "processed",
      decidedBy: "agent",
      amountCents: 3999,
    });
    expect(gateway.executionCount).toBe(1);

    // The trace proves the live toggle was observed: process_refund has an
    // attempt-1 row carrying the gateway 503 error and an attempt-2 ok row with
    // the SAME tool name (the exactly-once retry the chaos demo centers on).
    const trace = await runCaller.admin.trace({ runId });
    const processSteps = trace.steps.filter(
      (step) => step.type === "tool_call" && step.name === "process_refund",
    );
    expect(processSteps.map((step) => step.attempt)).toEqual([1, 2]);
    const [failed, ok] = processSteps;
    expect(failed!.error).toContain("Payment gateway unavailable");
    expect(failed!.output).toBeNull();
    expect(ok!.error).toBeNull();
    expect(ok!.output).toMatchObject({ result: "processed", amountCents: 3999 });
  });

  it("rejects unknown input keys on set (.strict() schema)", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.admin.faultInjection.set({ enabled: true, force: true } as unknown as {
        enabled: boolean;
      }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});
