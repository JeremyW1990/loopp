// ---------------------------------------------------------------------------
// Transport-layer tests for the customers/conversation/chat routers, driven
// through appRouter.createCaller with an EXPLICITLY constructed context: a
// test db handle plus scripted AgentDeps. The suite never loads the server's
// env/context modules and never touches the network, so it passes with no
// ANTHROPIC_API_KEY — and a locally-present key cannot change behavior,
// because getLlm is injected rather than resolved from the environment.
//
// Reseeds via runSeed(db) in beforeAll: seed dates are relative to seed time,
// so a stale DB would silently drift scenario orders out of policy windows.
// ---------------------------------------------------------------------------

import {
  LlmCallError,
  MissingApiKeyError,
  MockPaymentGateway,
  createRunEventBus,
  createScriptedLlmClient,
  renderPolicyMarkdown,
  replayRunEvents,
  type AgentDeps,
  type LlmClient,
  type LlmResponse,
  type LlmUsage,
  type RunEvent,
  type RunEventBus,
  type ScriptedLlmClient,
  type ScriptedLlmResult,
} from "@loopp/agent";
import {
  agentRuns,
  conversations,
  createDb,
  messages,
  refunds,
  runSeed,
  type Db,
} from "@loopp/db";
import { newId } from "@loopp/shared";
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

// --- Harness -------------------------------------------------------------------

interface CallerHarness {
  caller: ReturnType<typeof appRouter.createCaller>;
  llm: ScriptedLlmClient;
  gateway: MockPaymentGateway;
}

/** Caller whose agent deps wrap a scripted LLM client (no key, no network). */
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

/** Caller whose getLlm throws — exactly what production does with no key. */
function buildKeylessCaller() {
  const agent: AgentDeps = {
    db,
    getLlm: () => {
      throw new MissingApiKeyError();
    },
    model: MODEL,
    gateway: new MockPaymentGateway(),
  };
  return appRouter.createCaller({ db, agent });
}

interface BusCallerHarness {
  caller: ReturnType<typeof appRouter.createCaller>;
  /** The live event bus wired into agent deps — what chat.runEvents forwards. */
  bus: RunEventBus;
  gateway: MockPaymentGateway;
}

/**
 * Caller whose agent deps carry a REAL event bus (the default buildCaller omits
 * it, so live-path coverage of chat.runEvents needs this). The LLM client is
 * supplied directly so a test can gate it — holding a run in flight long enough
 * to attach a subscription while agent_runs.status is still 'running', exercising
 * the live bus-forwarding branch rather than the finished-run replay branch.
 * Still scripted, still no key, still no network.
 */
function buildBusCaller(llm: LlmClient): BusCallerHarness {
  const bus = createRunEventBus();
  const gateway = new MockPaymentGateway();
  const agent: AgentDeps = {
    db,
    getLlm: () => llm,
    model: MODEL,
    gateway,
    sleep: async () => {},
    events: bus,
  };
  return { caller: appRouter.createCaller({ db, agent }), bus, gateway };
}

/**
 * Wrap a scripted client so its FIRST createMessage call blocks until `release()`
 * is called. The agent inserts the running agent_runs row and then awaits this
 * gate, giving the test a deterministic window to discover the runId and attach
 * a subscription before the run finishes — no sleeps, no polling races.
 */
function gateFirstCall(inner: LlmClient): {
  llm: LlmClient;
  /** Resolves once the loop has reached (and is parked at) the first LLM call. */
  reachedFirstCall: Promise<void>;
  /** Unblock the first call so the run proceeds to completion. */
  release: () => void;
} {
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let signalReached!: () => void;
  const reachedFirstCall = new Promise<void>((resolve) => {
    signalReached = resolve;
  });
  let gated = false;

  const llm: LlmClient = {
    async createMessage(request) {
      if (!gated) {
        gated = true;
        signalReached();
        await gate;
      }
      return inner.createMessage(request);
    },
  };
  return { llm, reachedFirstCall, release: releaseGate };
}

/**
 * Drain an async-iterable subscription into an array. createCaller resolves an
 * async-generator subscription to its output iterable directly (tRPC v11
 * DecorateProcedure), so chat.runEvents is consumed by `for await`. The cap is a
 * safety net: a correct stream always ends on run_finished, so we never hit it.
 */
async function collectEvents(
  iterable: AsyncIterable<RunEvent>,
  cap = 200,
): Promise<RunEvent[]> {
  const collected: RunEvent[] = [];
  for await (const event of iterable) {
    collected.push(event);
    if (event.type === "run_finished") break;
    if (collected.length >= cap) break;
  }
  return collected;
}

/** Poll for the single running run on a conversation (its id is loop-internal). */
async function waitForRunningRunId(conversationId: string): Promise<string> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.conversationId, conversationId),
          eq(agentRuns.status, "running"),
        ),
      )
      .limit(1);
    if (rows[0] !== undefined) return rows[0].id;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`no running run appeared for ${conversationId}`);
}

/** The ordered event TYPES — what the status-chip stream renders, order-sensitive. */
function eventTypes(events: readonly RunEvent[]): string[] {
  return events.map((event) => event.type);
}

let toolUseCounter = 0;

function endTurn(text: string): LlmResponse {
  return { stopReason: "end_turn", content: [{ type: "text", text }], usage: USAGE };
}

function toolUse(name: string, input: unknown): LlmResponse {
  toolUseCounter += 1;
  return {
    stopReason: "tool_use",
    content: [{ type: "tool_use", id: `tu_srv_${toolUseCounter}`, name, input }],
    usage: USAGE,
  };
}

async function createConversation(customerId: string): Promise<string> {
  const id = newId("conv");
  await db.insert(conversations).values({ id, customerId, createdAt: new Date() });
  return id;
}

/** messages/agent_runs row counts, for the zero-rows-written assertions. */
async function tableCounts() {
  const messageRows = await db.select({ id: messages.id }).from(messages);
  const runRows = await db.select({ id: agentRuns.id }).from(agentRuns);
  return { messages: messageRows.length, runs: runRows.length };
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

// --- customers.list -------------------------------------------------------------

describe("customers.list", () => {
  it("returns the 15 seeded customers as {id,name,email}, ordered by id", async () => {
    const { caller } = buildCaller();
    const list = await caller.customers.list();

    expect(list).toHaveLength(15);
    expect(list.map((c) => c.id)).toEqual(
      Array.from({ length: 15 }, (_, i) => `cus_${String(i + 1).padStart(3, "0")}`),
    );
    expect(list[0]).toEqual({
      id: "cus_001",
      name: "Maya Chen",
      email: "maya.chen@example.com",
    });
    // Exactly the three public fields — nothing else leaks through.
    expect(Object.keys(list[0]!).sort()).toEqual(["email", "id", "name"]);
  });
});

// --- conversation.create / conversation.messages ---------------------------------

describe("conversation router", () => {
  it("create inserts a conversation row for an existing customer", async () => {
    const { caller } = buildCaller();
    const { conversationId } = await caller.conversation.create({
      customerId: "cus_009",
    });

    expect(conversationId).toMatch(/^conv_/);
    const rows = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.customerId).toBe("cus_009");
  });

  it("create rejects an unknown customer with NOT_FOUND and writes no row", async () => {
    const { caller } = buildCaller();
    const before = (await db.select({ id: conversations.id }).from(conversations))
      .length;

    const error = await rejectionOf(
      caller.conversation.create({ customerId: "cus_999" }),
    );
    expect(error.code).toBe("NOT_FOUND");

    const after = (await db.select({ id: conversations.id }).from(conversations))
      .length;
    expect(after).toBe(before);
  });

  it("messages is NOT_FOUND for an unknown conversation", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.conversation.messages({ conversationId: "conv_does_not_exist" }),
    );
    expect(error.code).toBe("NOT_FOUND");
  });
});

// --- conversation.orders (sidebar source; session-scoped identity) ---------------
//
// The chat sidebar reads orders through this query. The decisive invariant is
// SESSION-SCOPED IDENTITY: customerId is resolved from the conversation row, not
// from input, so the query can only ever surface the bound customer's data —
// there is no per-request customerId to spoof (the .strict() schema rejects one).
// Also covers the demo affordances the sidebar renders (final-sale flag, status,
// delivered/ordered dates, integer-cents prices) and the zero-order empty state.

describe("conversation.orders", () => {
  it("returns the conversation customer's orders + items with the sidebar fields", async () => {
    const conversationId = await createConversation("cus_001");
    const { caller } = buildCaller();

    const ordersOut = await caller.conversation.orders({ conversationId });

    // cus_001 owns exactly ord_1001..ord_1005. The query orders by orderedAt
    // asc (id asc tiebreak), so oldest-ordered first: ord_1005 (164d ago) …
    // ord_1001 (9d ago). The exact sequence is the query's contract.
    expect(ordersOut.map((order) => order.id)).toEqual([
      "ord_1005",
      "ord_1004",
      "ord_1002",
      "ord_1003",
      "ord_1001",
    ]);
    // Returned in non-descending orderedAt order.
    for (let i = 1; i < ordersOut.length; i += 1) {
      expect(ordersOut[i]!.orderedAt.getTime()).toBeGreaterThanOrEqual(
        ordersOut[i - 1]!.orderedAt.getTime(),
      );
    }

    // ord_1001 carries its two seeded line items with integer-cents prices,
    // quantities, and the final-sale flag — exactly what the sidebar renders.
    const ord1001 = ordersOut.find((order) => order.id === "ord_1001")!;
    expect(ord1001).toMatchObject({
      status: "delivered",
      shippingCents: 799,
      totalCents: 799 + 5999 + 3499 * 2,
    });
    expect(ord1001.orderedAt).toBeInstanceOf(Date);
    expect(ord1001.deliveredAt).toBeInstanceOf(Date);
    expect(ord1001.items).toEqual([
      {
        id: "itm_1001_1",
        name: "Ceramic Pour-Over Coffee Set",
        unitPriceCents: 5999,
        quantity: 1,
        isFinalSale: false,
      },
      {
        id: "itm_1001_2",
        name: "Aria Linen Throw Pillow",
        unitPriceCents: 3499,
        quantity: 2,
        isFinalSale: false,
      },
    ]);
    // Every price is integer cents (the UI formats with formatCents; no floats).
    for (const order of ordersOut) {
      expect(Number.isSafeInteger(order.totalCents)).toBe(true);
      expect(Number.isSafeInteger(order.shippingCents)).toBe(true);
      for (const item of order.items) {
        expect(Number.isSafeInteger(item.unitPriceCents)).toBe(true);
      }
    }
  });

  it("surfaces the final-sale badge flag (cus_001 ord_1003 silk dress)", async () => {
    const conversationId = await createConversation("cus_001");
    const { caller } = buildCaller();

    const ordersOut = await caller.conversation.orders({ conversationId });
    const ord1003 = ordersOut.find((order) => order.id === "ord_1003")!;
    const dress = ord1003.items.find((item) => item.id === "itm_1003_1")!;
    expect(dress.isFinalSale).toBe(true);
    // The other line item in the same order is NOT final sale.
    const boots = ord1003.items.find((item) => item.id === "itm_1003_2")!;
    expect(boots.isFinalSale).toBe(false);
  });

  it("returns an untrusted product name verbatim (escaping is the UI's job)", async () => {
    // cus_006 ord_1018 carries a prompt-injection payload in a product name.
    // The query returns it as-is; the React UI renders it as escaped text.
    const conversationId = await createConversation("cus_006");
    const { caller } = buildCaller();

    const ordersOut = await caller.conversation.orders({ conversationId });
    const injected = ordersOut
      .flatMap((order) => order.items)
      .find((item) => item.id === "itm_1018_1")!;
    expect(injected.name).toContain("IGNORE ALL PREVIOUS INSTRUCTIONS");
    expect(injected.isFinalSale).toBe(true);
  });

  it("a processing order has no deliveredAt (cus_013 ord_1033)", async () => {
    const conversationId = await createConversation("cus_013");
    const { caller } = buildCaller();

    const ordersOut = await caller.conversation.orders({ conversationId });
    const processing = ordersOut.find((order) => order.id === "ord_1033")!;
    expect(processing.status).toBe("processing");
    expect(processing.deliveredAt).toBeNull();
  });

  it("returns an empty array for a customer with no orders (cus_010)", async () => {
    const conversationId = await createConversation("cus_010");
    const { caller } = buildCaller();

    expect(await caller.conversation.orders({ conversationId })).toEqual([]);
  });

  it("is session-scoped: a different conversation only ever sees ITS customer's orders", async () => {
    // Two conversations for two customers. Each orders() call returns only the
    // orders of the customer bound to THAT conversation — identity comes from
    // the conversation row, never from the caller. cus_005's orders never leak
    // into cus_001's sidebar and vice-versa.
    const conv1 = await createConversation("cus_001");
    const conv5 = await createConversation("cus_005");
    const { caller } = buildCaller();

    const out1 = await caller.conversation.orders({ conversationId: conv1 });
    const out5 = await caller.conversation.orders({ conversationId: conv5 });

    expect(out1.every((order) => order.id.startsWith("ord_100"))).toBe(true);
    // cus_005 owns exactly ord_1015..ord_1017 (orderedAt asc → ord_1017 64d,
    // ord_1015 15d, ord_1016 5d); none of those appear in cus_001's result.
    const ids1 = new Set(out1.map((order) => order.id));
    expect(ids1.has("ord_1016")).toBe(false);
    expect(new Set(out5.map((order) => order.id))).toEqual(
      new Set(["ord_1015", "ord_1016", "ord_1017"]),
    );
    const ids5 = new Set(out5.map((order) => order.id));
    expect(ids5.has("ord_1001")).toBe(false);
  });

  it("rejects an unknown conversation with NOT_FOUND", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.conversation.orders({ conversationId: "conv_does_not_exist" }),
    );
    expect(error.code).toBe("NOT_FOUND");
  });

  it("rejects a per-request customerId (.strict() schema — no identity spoofing)", async () => {
    // The whole point of session-scoped identity: there is no input field that
    // lets a caller name a customer. Smuggling one in is a BAD_REQUEST, so the
    // query can never be redirected at someone else's orders.
    const conversationId = await createConversation("cus_010");
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.conversation.orders({
        conversationId,
        customerId: "cus_001",
      } as unknown as { conversationId: string }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});

// --- system.policy (viewable refund policy) --------------------------------------
//
// The UI's policy viewer reads this. It returns renderPolicyMarkdown() from
// @loopp/agent — byte-identical to docs/refund-policy.md (guaranteed by the agent
// render sync test), NOT read from disk, keeping server→agent layering one-way.

describe("system.policy", () => {
  it("returns the rendered policy markdown from @loopp/agent", async () => {
    const { caller } = buildCaller();
    const { markdown } = await caller.system.policy();

    // Exactly the agent's render — not a disk read, not a transformed copy.
    expect(markdown).toBe(renderPolicyMarkdown());
    // The rendered doc carries the policy numbers the UI shows as escaped text.
    expect(markdown).toContain("# Loopp Refund Policy");
    expect(markdown).toContain("30 days");
    expect(markdown).toContain("$500.00");
  });
});

// --- chat.sendMessage -------------------------------------------------------------

describe("chat.sendMessage", () => {
  it("happy path: persists user+assistant messages, returns {runId, reply}, reply matches DB state", async () => {
    const conversationId = await createConversation("cus_001");
    const userText = "My coffee set arrived chipped — can I get a refund?";
    const replyText =
      "Your refund of $59.99 for the Ceramic Pour-Over Coffee Set has been processed.";
    const { caller, llm, gateway } = buildCaller([
      toolUse("process_refund", {
        orderId: "ord_1001",
        itemIds: ["itm_1001_1"],
        reason: "arrived chipped",
      }),
      endTurn(replyText),
    ]);

    const result = await caller.chat.sendMessage({ conversationId, text: userText });

    expect(result.runId).toMatch(/^run_/);
    expect(result.reply).toBe(replyText);
    expect(llm.remaining()).toBe(0);

    // Messages persisted in order; the assistant row carries the runId and is
    // byte-identical to the returned reply.
    const history = await caller.conversation.messages({ conversationId });
    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: "user", content: userText, runId: null });
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: replyText,
      runId: result.runId,
    });

    // The run completed on the configured model…
    const runRows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, result.runId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.status).toBe("completed");
    expect(runRows[0]!.model).toBe(MODEL);

    // …and the reply's claim matches DB state: one processed refund row with
    // the server-computed amount, executed by the gateway exactly once.
    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, "ord_1001"));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      status: "processed",
      decidedBy: "agent",
      amountCents: 5999,
      itemIds: ["itm_1001_1"],
      conversationId,
      runId: result.runId,
    });
    expect(refundRows[0]!.gatewayRef).toBe(`gw_${refundRows[0]!.id}`);
    expect(gateway.executionCount).toBe(1);
  });

  it("rejects text over 2000 chars via zod, before any row is written", async () => {
    const conversationId = await createConversation("cus_002");
    const { caller, llm } = buildCaller();
    const before = await tableCounts();

    const error = await rejectionOf(
      caller.chat.sendMessage({ conversationId, text: "x".repeat(2001) }),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(llm.requests).toHaveLength(0);
    expect(await tableCounts()).toEqual(before);
  });

  it("rejects empty text", async () => {
    const conversationId = await createConversation("cus_002");
    const { caller } = buildCaller();

    const error = await rejectionOf(
      caller.chat.sendMessage({ conversationId, text: "" }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });

  it("rejects unknown input keys (.strict() schema)", async () => {
    const conversationId = await createConversation("cus_002");
    const { caller } = buildCaller();
    const before = await tableCounts();

    const input = { conversationId, text: "hello", amountCents: 99_999 };
    const error = await rejectionOf(
      caller.chat.sendMessage(
        input as unknown as { conversationId: string; text: string },
      ),
    );
    expect(error.code).toBe("BAD_REQUEST");
    expect(await tableCounts()).toEqual(before);
  });

  it("missing API key → PRECONDITION_FAILED naming the exact fix, zero rows written", async () => {
    const conversationId = await createConversation("cus_003");
    const caller = buildKeylessCaller();
    const before = await tableCounts();

    const error = await rejectionOf(
      caller.chat.sendMessage({ conversationId, text: "Refund my order please" }),
    );
    expect(error.code).toBe("PRECONDITION_FAILED");
    expect(error.message).toBe(
      "ANTHROPIC_API_KEY is not set. Add it to .env and restart the server.",
    );
    expect(await tableCounts()).toEqual(before);
  });

  it("unknown conversation → NOT_FOUND, zero rows written", async () => {
    const { caller } = buildCaller([endTurn("never reached")]);
    const before = await tableCounts();

    const error = await rejectionOf(
      caller.chat.sendMessage({ conversationId: "conv_missing", text: "hi" }),
    );
    expect(error.code).toBe("NOT_FOUND");
    expect(await tableCounts()).toEqual(before);
  });

  it("a failed run maps to INTERNAL_SERVER_ERROR; run row failed, no assistant message", async () => {
    const conversationId = await createConversation("cus_004");
    const { caller } = buildCaller([
      new LlmCallError("provider rejected the request", {
        retryable: false,
        status: 400,
      }),
    ]);

    const error = await rejectionOf(
      caller.chat.sendMessage({ conversationId, text: "hello" }),
    );
    expect(error.code).toBe("INTERNAL_SERVER_ERROR");

    // The user message persisted, the run was finalized 'failed', and no
    // assistant message claims an outcome that never happened.
    const history = await caller.conversation.messages({ conversationId });
    expect(history).toHaveLength(1);
    expect(history[0]!.role).toBe("user");

    const runRows = await db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.conversationId, conversationId));
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.status).toBe("failed");
  });
});

// --- chat.runEvents (SSE subscription) ------------------------------------------
//
// The SSE contract, exercised programmatically through createCaller (the
// integration analogue of the browser's httpSubscriptionLink). Two paths:
//
//   • LIVE — subscribe while agent_runs.status is 'running'; the subscription
//     forwards the in-process event bus the loop emits into. A gated LLM client
//     parks the run at its first call so the subscription attaches mid-flight
//     (status 'running'), rather than after sendMessage returns (by when the run
//     is already finished and only replay would run).
//   • REPLAY — subscribe to the now-finished run; the subscription reconstructs
//     an equivalent ordered stream from agent_steps (replayRunEvents) so a late
//     subscriber / page reload renders the same chips as the live one.
//
// Scripted LLM, no key, no network — consistent with the rest of this suite.

describe("chat.runEvents", () => {
  it("live path: streams the ordered run lifecycle in flight, then the finished run replays the same shape; reply + refund match DB", async () => {
    // ord_1026 (cus_009) — eligible, in-window, sub-threshold, and touched by no
    // other test, so process_refund genuinely creates a refund row to assert on.
    const conversationId = await createConversation("cus_009");
    const userText = "My trail running socks arrived with a hole — refund please?";
    const replyText =
      "Your refund of $18.99 for the Trail Running Socks (3 pk) has been processed.";

    const script = createScriptedLlmClient([
      toolUse("process_refund", {
        orderId: "ord_1026",
        itemIds: ["itm_1026_1"],
        reason: "arrived with a hole",
      }),
      endTurn(replyText),
    ]);
    const gate = gateFirstCall(script);
    const { caller, gateway } = buildBusCaller(gate.llm);

    // Fire the turn but do NOT await — it parks at the gated first LLM call with
    // the run row already inserted as 'running'.
    const turn = caller.chat.sendMessage({ conversationId, text: userText });

    // The user message is persisted before the run even opens.
    await gate.reachedFirstCall;
    const midRunHistory = await caller.conversation.messages({ conversationId });
    expect(midRunHistory).toHaveLength(1);
    expect(midRunHistory[0]).toMatchObject({ role: "user", content: userText });

    // Attach the subscription while the run is genuinely in flight (status
    // 'running' → the live bus-forwarding branch, not replay).
    const runId = await waitForRunningRunId(conversationId);
    const liveIterable = await caller.chat.runEvents({ runId });
    const liveCollector = collectEvents(liveIterable);

    // Let the run finish; collect everything the subscription delivered.
    gate.release();
    const result = await turn;
    const liveEvents = await liveCollector;

    expect(result.runId).toBe(runId);
    expect(result.reply).toBe(replyText);

    // Ordered lifecycle: user message persisted (asserted above) → run_started →
    // llm_call started/finished → tool_call started/finished (process_refund) →
    // llm_call started/finished → run_finished. A status-chip stream in order.
    expect(eventTypes(liveEvents)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);

    // Brackets + identity: run_started seq 0, run_finished completed, every event
    // carries this runId, seq is non-decreasing (de-dupable against any replay).
    expect(liveEvents[0]).toEqual({ type: "run_started", runId, seq: 0 });
    const liveLast = liveEvents.at(-1)!;
    expect(liveLast).toMatchObject({ type: "run_finished", status: "completed" });
    expect(liveEvents.every((event) => event.runId === runId)).toBe(true);
    const liveSeqs = liveEvents.map((event) => event.seq);
    for (let i = 1; i < liveSeqs.length; i += 1) {
      expect(liveSeqs[i]!).toBeGreaterThanOrEqual(liveSeqs[i - 1]!);
    }

    // The single tool_call surfaces with its name and attempt 1.
    const toolStarted = liveEvents.find((event) => event.type === "tool_call_started");
    expect(toolStarted).toMatchObject({ name: "process_refund", attempt: 1 });
    const toolFinished = liveEvents.find(
      (event): event is Extract<RunEvent, { type: "tool_call_finished" }> =>
        event.type === "tool_call_finished",
    );
    expect(toolFinished).toMatchObject({ name: "process_refund", attempt: 1 });
    // A successful tool call carries no error key (the finished shape omits it).
    expect(toolFinished?.error).toBeUndefined();

    // Say only what happened: the assistant reply is persisted and byte-identical
    // to the streamed run's outcome.
    const history = await caller.conversation.messages({ conversationId });
    expect(history.map((row) => row.role)).toEqual(["user", "assistant"]);
    expect(history[1]).toMatchObject({
      role: "assistant",
      content: replyText,
      runId,
    });

    // …and the run + refund the chips described are real DB state.
    const runRows = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    expect(runRows[0]!.status).toBe("completed");
    const refundRows = await db
      .select()
      .from(refunds)
      .where(eq(refunds.orderId, "ord_1026"));
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0]).toMatchObject({
      status: "processed",
      decidedBy: "agent",
      amountCents: 1899,
      itemIds: ["itm_1026_1"],
      conversationId,
      runId,
    });
    expect(gateway.executionCount).toBe(1);

    // LATE-SUBSCRIBER PARITY: subscribing to the now-finished run replays an
    // equivalent ordered stream (the reload / late-join path). It equals what
    // replayRunEvents reconstructs from agent_steps, and is type-for-type the
    // live stream — so live and replayed chips render identically.
    const replayIterable = await caller.chat.runEvents({ runId });
    const replayEvents = await collectEvents(replayIterable);

    expect(replayEvents).toEqual(await replayRunEvents(db, runId));
    expect(eventTypes(replayEvents)).toEqual(eventTypes(liveEvents));
    expect(replayEvents[0]).toEqual({ type: "run_started", runId, seq: 0 });
    expect(replayEvents.at(-1)).toMatchObject({
      type: "run_finished",
      status: "completed",
    });
    // Identical seqs end to end → the (type, seq) de-dupe across a live→replay
    // hand-off would fire each event exactly once.
    expect(replayEvents.map((event) => [event.type, event.seq])).toEqual(
      liveEvents.map((event) => [event.type, event.seq]),
    );
  });

  it("unknown runId yields an empty stream (replay of nothing), no throw", async () => {
    const { caller } = buildCaller();
    const iterable = await caller.chat.runEvents({ runId: "run_nope" });
    expect(await collectEvents(iterable)).toEqual([]);
  });

  it("rejects unknown input keys (.strict() schema)", async () => {
    const { caller } = buildCaller();
    const error = await rejectionOf(
      caller.chat.runEvents({
        runId: "run_x",
        conversationId: "conv_x",
      } as unknown as { runId: string }),
    );
    expect(error.code).toBe("BAD_REQUEST");
  });
});
