// ---------------------------------------------------------------------------
// Admin business-logic tests — the authority-boundary core, DB-backed against
// the local compose Postgres, fully offline (no ANTHROPIC_API_KEY: approve and
// reject use only the mock gateway, and the one trace test drives the loop with
// a scripted LlmClient). Reseeds via runSeed(db) in beforeAll; afterEach resets
// app_settings 'fault_injection' to false because it leaks between tests.
//
// What is pinned here:
//   - approveEscalatedRefund is exactly-once under a double-click: two calls
//     for one escalated refund execute the gateway ONCE and leave exactly one
//     'approved' row (decidedBy='admin', resolvedAt + gatewayRef=gw_<id> set).
//   - With fault_injection on, approve still succeeds via a single same-key
//     retry and stays exactly-once — no 'approved' row is written on the failed
//     first attempt.
//   - rejectEscalatedRefund writes 'rejected' with the note and decidedBy=
//     'admin' and NEVER calls the gateway; a rejected item is refundable again
//     (a fresh process_refund over it is not blocked).
//   - approve/reject on an absent id throw RefundNotFoundError and on a
//     non-escalated (terminal) id throw RefundNotEscalatedError — neither
//     writes a row nor moves money.
//   - getRunTrace returns the persisted agent_steps verbatim in strict seq
//     order under the run header.
//
// Each test uses a disjoint seed order / refund id so the single reseed keeps
// them independent within this file.
// ---------------------------------------------------------------------------

import { appSettings, refunds, runSeed } from "@loopp/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RefundNotEscalatedError,
  RefundNotFoundError,
  approveEscalatedRefund,
  getRunTrace,
  rejectEscalatedRefund,
  type AdminDeps,
} from "./admin";
import { MockPaymentGateway } from "./gateway";
import {
  createScriptedLlmClient,
  type LlmResponse,
  type LlmUsage,
} from "./llm";
import { runAgentTurn, type AgentDeps } from "./loop";
import { executeTool } from "./tools";
import {
  connectTestDb,
  createTestConversation,
  createToolHarness,
  type TestDb,
} from "./test-helpers";

const MODEL = "claude-sonnet-4-6";
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

// --- Fixtures -----------------------------------------------------------------

/** A fresh AdminDeps over the shared test DB with its own gateway. */
function adminDeps(gateway = new MockPaymentGateway()): {
  deps: AdminDeps;
  gateway: MockPaymentGateway;
} {
  return { deps: { db: testDb.db, gateway }, gateway };
}

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
 * Insert one refunds row directly — the deterministic way to stage an
 * escalated (or terminal) fixture without driving the agent loop. Mirrors the
 * lifecycle shape the tools/loop write per status: escalated rows are
 * undecided with no gatewayRef/resolvedAt; processed rows carry both.
 */
async function insertRefund(input: SeedRefundInput): Promise<string> {
  const now = new Date();
  const resolved = input.status !== "escalated";
  await testDb.db.insert(refunds).values({
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
  const rows = await testDb.db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  return rows[0] ?? null;
}

async function approvedCount(refundId: string) {
  const rows = await testDb.db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "approved")));
  return rows.length;
}

// --- (a) Approve: exactly-once under a double-click ---------------------------

describe("approveEscalatedRefund exactly-once", () => {
  it("double-approve of one escalated refund executes the gateway once and writes a single 'approved' row", async () => {
    // ord_1002 ($899) is over the $500 threshold — the agent could only have
    // escalated it, so admin approve is the sole path that resolves it.
    const refundId = "ref_admin_a1";
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });
    const { deps, gateway } = adminDeps();

    // Two sequential calls stand in for a double-click / a replay.
    const first = await approveEscalatedRefund(deps, refundId);
    const second = await approveEscalatedRefund(deps, refundId);

    // Money moved exactly once; both calls return the same resolved row.
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
    // Admin approve never stamps a note.
    expect(row?.adminNote).toBeNull();
  });

  it("approving an already-'approved' refund is an idempotent no-op (no second execution)", async () => {
    const refundId = "ref_admin_a2";
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });
    const { deps, gateway } = adminDeps();

    await approveEscalatedRefund(deps, refundId);
    const resolvedAtAfterFirst = (await refundRow(refundId))?.resolvedAt;

    // A third actor re-approves the now-resolved row: still one execution, and
    // the resolution timestamp is untouched (the conditional UPDATE matched 0
    // rows the second time).
    const again = await approveEscalatedRefund(deps, refundId, () => new Date(0));
    expect(gateway.executionCount).toBe(1);
    expect(again.status).toBe("approved");
    expect(again.resolvedAt).toEqual(resolvedAtAfterFirst);
    expect(await approvedCount(refundId)).toBe(1);
  });
});

// --- (b) Approve under fault injection: single same-key retry -----------------

describe("approveEscalatedRefund under fault injection", () => {
  it("first gateway attempt fails (503) then retries once with the same key — succeeds exactly-once, no row on the failed attempt", async () => {
    const refundId = "ref_admin_fault";
    await insertRefund({
      id: refundId,
      orderId: "ord_1023",
      customerId: "cus_008",
      itemIds: ["itm_1023_1"],
      amountCents: 52500,
      status: "escalated",
    });

    // Chaos on: the gateway's FIRST attempt per key throws GatewayUnavailableError.
    await testDb.db
      .update(appSettings)
      .set({ value: true })
      .where(eq(appSettings.key, "fault_injection"));

    const { deps, gateway } = adminDeps();
    const resolved = await approveEscalatedRefund(deps, refundId);

    // The single same-key retry succeeded; money moved exactly once.
    expect(resolved.status).toBe("approved");
    expect(resolved.gatewayRef).toBe(`gw_${refundId}`);
    expect(gateway.executionCount).toBe(1);
    expect(await approvedCount(refundId)).toBe(1);
    const row = await refundRow(refundId);
    expect(row?.decidedBy).toBe("admin");
    expect(row?.resolvedAt).not.toBeNull();
  });
});

// --- (c) Reject: note recorded, no gateway call -------------------------------

describe("rejectEscalatedRefund", () => {
  it("sets 'rejected' with the admin note and decidedBy='admin' and never calls the gateway", async () => {
    const refundId = "ref_admin_rej1";
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });
    const { deps, gateway } = adminDeps();
    const note = "Customer opened a chargeback; declining the duplicate refund.";

    const rejected = await rejectEscalatedRefund(deps, refundId, note);

    expect(rejected.status).toBe("rejected");
    expect(rejected.decidedBy).toBe("admin");
    expect(rejected.adminNote).toBe(note);
    expect(rejected.resolvedAt).not.toBeNull();
    // No money ever moves on a rejection.
    expect(rejected.gatewayRef).toBeNull();
    expect(gateway.executionCount).toBe(0);
  });

  it("re-rejecting an already-'rejected' refund is an idempotent no-op (still no gateway call)", async () => {
    const refundId = "ref_admin_rej2";
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });
    const { deps, gateway } = adminDeps();

    const first = await rejectEscalatedRefund(deps, refundId, "first note");
    const again = await rejectEscalatedRefund(deps, refundId, "second note");

    // The original decision stands; the second call neither rewrote the note
    // nor touched the gateway.
    expect(again.status).toBe("rejected");
    expect(again.adminNote).toBe("first note");
    expect(again.resolvedAt).toEqual(first.resolvedAt);
    expect(gateway.executionCount).toBe(0);
  });

  it("frees the item: a rejected refund does not block a fresh process_refund over the same item", async () => {
    // ord_1021/itm_1021_1 ($54.99) is in-window, eligible, sub-threshold, and
    // untouched by every other test — so after the escalated row is rejected,
    // a real process_refund must succeed (loadPriorRefunds excludes 'rejected').
    const refundId = "ref_admin_free";
    await insertRefund({
      id: refundId,
      orderId: "ord_1021",
      customerId: "cus_007",
      itemIds: ["itm_1021_1"],
      amountCents: 5499,
      status: "escalated",
    });
    const { deps } = adminDeps();
    await rejectEscalatedRefund(deps, refundId, "wrong item escalated by mistake");

    // Drive the real process_refund tool as cus_007 over the same item.
    const harness = await createToolHarness(testDb.db, "cus_007");
    const execution = await executeTool(
      "process_refund",
      {
        orderId: "ord_1021",
        itemIds: ["itm_1021_1"],
        reason: "blanket arrived with a snag",
      },
      harness.ctx,
    );

    expect(execution.isError).toBe(false);
    expect(execution.output).toMatchObject({
      result: "processed",
      amountCents: 5499,
    });
    expect(harness.gateway.executionCount).toBe(1);

    // The ledger now holds the rejected fixture plus a brand-new processed
    // refund for the same item — the rejection did not lock it.
    const rows = await testDb.db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, "ord_1021"))
      .orderBy(asc(refunds.createdAt));
    const byStatus = rows.map((row) => row.status).sort();
    expect(byStatus).toEqual(["processed", "rejected"]);
    const processed = rows.find((row) => row.status === "processed");
    expect(processed?.itemIds).toEqual(["itm_1021_1"]);
    expect(processed?.id).not.toBe(refundId);
  });
});

// --- (d) Guard branches: not-found and not-escalated --------------------------

describe("approve/reject guards", () => {
  it("approve on an absent id throws RefundNotFoundError and moves no money", async () => {
    const { deps, gateway } = adminDeps();
    await expect(
      approveEscalatedRefund(deps, "ref_does_not_exist"),
    ).rejects.toBeInstanceOf(RefundNotFoundError);
    expect(gateway.executionCount).toBe(0);
  });

  it("reject on an absent id throws RefundNotFoundError and moves no money", async () => {
    const { deps, gateway } = adminDeps();
    await expect(
      rejectEscalatedRefund(deps, "ref_does_not_exist", "note"),
    ).rejects.toBeInstanceOf(RefundNotFoundError);
    expect(gateway.executionCount).toBe(0);
  });

  it("approve on a non-escalated (processed) refund throws RefundNotEscalatedError without touching the row or the gateway", async () => {
    const refundId = "ref_admin_terminal_a";
    await insertRefund({
      id: refundId,
      orderId: "ord_1013",
      customerId: "cus_004",
      itemIds: ["itm_1013_1"],
      amountCents: 3999,
      status: "processed",
    });
    const before = await refundRow(refundId);
    const { deps, gateway } = adminDeps();

    await expect(approveEscalatedRefund(deps, refundId)).rejects.toBeInstanceOf(
      RefundNotEscalatedError,
    );

    // The processed row is untouched and the gateway never ran.
    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);
  });

  it("reject on a non-escalated (processed) refund throws RefundNotEscalatedError without touching the row or the gateway", async () => {
    const refundId = "ref_admin_terminal_r";
    await insertRefund({
      id: refundId,
      orderId: "ord_1013",
      customerId: "cus_004",
      itemIds: ["itm_1013_1"],
      amountCents: 3999,
      status: "processed",
    });
    const before = await refundRow(refundId);
    const { deps, gateway } = adminDeps();

    await expect(
      rejectEscalatedRefund(deps, refundId, "note"),
    ).rejects.toBeInstanceOf(RefundNotEscalatedError);

    expect(await refundRow(refundId)).toEqual(before);
    expect(gateway.executionCount).toBe(0);

    // The typed error carries the offending status for the router to map.
    const error = await rejectEscalatedRefund(deps, refundId, "note").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(RefundNotEscalatedError);
    expect((error as RefundNotEscalatedError).status).toBe("processed");
  });
});

// --- (e) getRunTrace: persisted steps verbatim in strict seq order ------------

describe("getRunTrace", () => {
  it("returns the run header and its agent_steps verbatim in strict seq order", async () => {
    // Drive a real, persisted run (scripted LLM, no key) so there are genuine
    // agent_steps to read back — getRunTrace must surface them unchanged.
    const conversationId = await createTestConversation(testDb.db, "cus_006");
    const gateway = new MockPaymentGateway();
    const llm = createScriptedLlmClient([
      toolUse("get_order", { orderId: "ord_1019" }),
      toolUse("process_refund", {
        orderId: "ord_1019",
        itemIds: ["itm_1019_1"],
        reason: "hub stopped charging",
      }),
      endTurn("Your refund of $34.99 for the 7-in-1 USB-C Hub has been processed."),
    ]);
    const deps: AgentDeps = {
      db: testDb.db,
      getLlm: () => llm,
      model: MODEL,
      gateway,
    };

    const result = await runAgentTurn(
      deps,
      conversationId,
      "My USB-C hub stopped charging — can I get a refund?",
    );

    const trace = await getRunTrace(testDb.db, result.runId);
    expect(trace).not.toBeNull();
    expect(trace!.run.runId).toBe(result.runId);
    expect(trace!.run.status).toBe("completed");
    expect(trace!.run.customerName).toBe("Liam Nakamura");

    // seq is strictly increasing with no gaps or duplicates.
    const seqs = trace!.steps.map((step) => step.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);

    // The step shape is the persisted trace verbatim — types within the closed
    // set, llm/tool alternation, the process_refund I/O carried through.
    expect(trace!.steps.map((step) => [step.type, step.name])).toEqual([
      ["llm_call", MODEL],
      ["tool_call", "get_order"],
      ["llm_call", MODEL],
      ["tool_call", "process_refund"],
      ["llm_call", MODEL],
    ]);
    const processStep = trace!.steps.find(
      (step) => step.name === "process_refund",
    )!;
    expect(processStep.input).toMatchObject({
      orderId: "ord_1019",
      itemIds: ["itm_1019_1"],
    });
    expect(processStep.output).toMatchObject({ result: "processed", amountCents: 3499 });
    expect(processStep.error).toBeNull();
  });

  it("returns null for an unknown runId", async () => {
    expect(await getRunTrace(testDb.db, "run_does_not_exist")).toBeNull();
  });
});

// --- Scripted-LLM helpers (mirror loop.test.ts) -------------------------------

let toolUseCounter = 0;

function endTurn(text: string): LlmResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage: USAGE };
}

function toolUse(name: string, input: unknown): LlmResponse {
  toolUseCounter += 1;
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `tu_${toolUseCounter}`, name, input }],
    usage: USAGE,
  };
}
