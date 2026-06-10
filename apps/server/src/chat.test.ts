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
  createScriptedLlmClient,
  type AgentDeps,
  type LlmResponse,
  type LlmUsage,
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
import { eq } from "drizzle-orm";
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
