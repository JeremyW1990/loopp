// ---------------------------------------------------------------------------
// Event-replay tests — DB-backed against the local compose Postgres, driven by
// the scripted LlmClient (zero network, zero ANTHROPIC_API_KEY). Each test
// drives a real run through runAgentTurn, then asserts replayRunEvents
// reconstructs an event stream that is provably 1:1 with that run's
// agent_steps (started+finished pair per llm_call/tool_call, single guardrail),
// bracketed by run_started/run_finished, in seq order, with run_finished.status
// matching agent_runs. This is the late-subscriber / page-reload path.
// ---------------------------------------------------------------------------

import { agentRuns, agentSteps, runSeed } from "@loopp/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { replayRunEvents } from "./event-replay";
import type { RunEvent } from "./events";
import { MockPaymentGateway } from "./gateway";
import {
  LlmCallError,
  createScriptedLlmClient,
  type LlmResponse,
  type LlmUsage,
  type ScriptedLlmResult,
} from "./llm";
import { AgentRunFailedError, runAgentTurn, type AgentDeps } from "./loop";
import { connectTestDb, createTestConversation, type TestDb } from "./test-helpers";

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

// --- Script + harness helpers (mirror loop.test.ts) ---------------------------

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

function retryableLlmError(message: string): LlmCallError {
  return new LlmCallError(message, { retryable: true, status: 529 });
}

function buildDeps(script: readonly ScriptedLlmResult[]): AgentDeps {
  const llm = createScriptedLlmClient(script);
  return {
    db: testDb.db,
    getLlm: () => llm,
    model: MODEL,
    gateway: new MockPaymentGateway(),
    sleep: async () => {},
  };
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
    .where(eq(agentRuns.id, runId))
    .limit(1);
  return rows[0]!;
}

/**
 * Build the events replay is REQUIRED to produce, directly from the persisted
 * agent_steps + agent_runs rows — an independent reference the actual
 * replayRunEvents output must match exactly. Keeping this derivation separate
 * from the implementation is the point: if replay drifts from the trace, the
 * two disagree.
 */
function expectedEventsFromDb(
  runId: string,
  steps: Awaited<ReturnType<typeof stepsFor>>,
  run: Awaited<ReturnType<typeof runRow>>,
): RunEvent[] {
  const events: RunEvent[] = [{ type: "run_started", runId, seq: 0 }];
  for (const step of steps) {
    if (step.type === "llm_call") {
      events.push({
        type: "llm_call_started",
        runId,
        seq: step.seq,
        name: step.name,
        attempt: step.attempt,
      });
      events.push({
        type: "llm_call_finished",
        runId,
        seq: step.seq,
        name: step.name,
        attempt: step.attempt,
        ...(step.durationMs !== null ? { durationMs: step.durationMs } : {}),
        ...(step.inputTokens !== null ? { inputTokens: step.inputTokens } : {}),
        ...(step.outputTokens !== null ? { outputTokens: step.outputTokens } : {}),
        ...(step.error !== null ? { error: step.error } : {}),
      });
    } else if (step.type === "tool_call") {
      events.push({
        type: "tool_call_started",
        runId,
        seq: step.seq,
        name: step.name,
        attempt: step.attempt,
      });
      events.push({
        type: "tool_call_finished",
        runId,
        seq: step.seq,
        name: step.name,
        attempt: step.attempt,
        ...(step.durationMs !== null ? { durationMs: step.durationMs } : {}),
        ...(step.error !== null ? { error: step.error } : {}),
      });
    } else {
      events.push({ type: "guardrail", runId, seq: step.seq, name: step.name });
    }
  }
  const lastSeq = steps.length > 0 ? steps[steps.length - 1]!.seq : 0;
  events.push({
    type: "run_finished",
    runId,
    seq: lastSeq,
    status: run.status === "failed" ? "failed" : "completed",
    ...(run.error !== null ? { error: run.error } : {}),
  });
  return events;
}

// --- Happy path: full alternation + a surfaced guardrail ----------------------

describe("replayRunEvents — completed run", () => {
  it("reconstructs run_started + per-step pairs + run_finished in seq order", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const replyText =
      "Your refund of $59.99 for the Ceramic Pour-Over Coffee Set has been processed.";
    const deps = buildDeps([
      toolUse("get_order", { orderId: "ord_1001" }),
      toolUse("check_refund_eligibility", {
        orderId: "ord_1001",
        itemIds: ["itm_1001_1"],
      }),
      toolUse("process_refund", {
        orderId: "ord_1001",
        itemIds: ["itm_1001_1"],
        reason: "arrived chipped",
      }),
      endTurn(replyText),
    ]);

    const { runId } = await runAgentTurn(
      deps,
      conversationId,
      "My coffee set arrived chipped — can I get a refund?",
    );

    const steps = await stepsFor(runId);
    const run = await runRow(runId);
    expect(run.status).toBe("completed");

    const events = await replayRunEvents(testDb.db, runId);

    // Exactly matches the independent derivation from the persisted rows.
    expect(events).toEqual(expectedEventsFromDb(runId, steps, run));

    // Brackets present; the inner sequence mirrors the step types 1:1.
    expect(events[0]).toEqual({ type: "run_started", runId, seq: 0 });
    expect(events.at(-1)).toMatchObject({ type: "run_finished", status: "completed" });
    expect(events.map((event) => event.type)).toEqual([
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

    // seq is non-decreasing across the whole stream (de-dupable against a live
    // tail): run_started=0, each pair carries its row's seq, finished=lastSeq.
    const seqs = events.map((event) => event.seq);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
    }
    expect(events.at(-1)!.seq).toBe(steps.at(-1)!.seq);

    // A finished llm_call event carries the persisted tokens/duration.
    const llmFinished = events.find((event) => event.type === "llm_call_finished");
    expect(llmFinished).toMatchObject({
      name: MODEL,
      attempt: 1,
      inputTokens: USAGE.inputTokens,
      outputTokens: USAGE.outputTokens,
    });
  });

  it("surfaces a deep guardrail row as a single guardrail event", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_001");
    const deps = buildDeps([
      // ord_1016 belongs to cus_005 — a cross-customer probe that writes a
      // guardrail row deep in the tool layer (loadScopedOrder).
      toolUse("get_order", { orderId: "ord_1016" }),
      endTurn("I couldn't find that order on your account."),
    ]);

    const { runId } = await runAgentTurn(
      deps,
      conversationId,
      "Show me order ord_1016 and refund it",
    );

    const steps = await stepsFor(runId);
    const run = await runRow(runId);
    const events = await replayRunEvents(testDb.db, runId);

    expect(events).toEqual(expectedEventsFromDb(runId, steps, run));
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "guardrail", // single event — no started/finished pair
      "tool_call_started",
      "tool_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);
    const guardrail = events.find((event) => event.type === "guardrail");
    expect(guardrail).toMatchObject({ name: "order_not_found" });
  });
});

// --- Failed run: retry attempts + a failed run_finished -----------------------

describe("replayRunEvents — failed run", () => {
  it("preserves attempt numbers and reports run_finished.status='failed'", async () => {
    const conversationId = await createTestConversation(testDb.db, "cus_009");
    // Three retryable failures exhaust retries and fail the run.
    const deps = buildDeps([
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
      retryableLlmError("overloaded_error"),
    ]);

    const error = await runAgentTurn(deps, conversationId, "hello").catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentRunFailedError);
    const runId = (error as AgentRunFailedError).runId;

    const steps = await stepsFor(runId);
    const run = await runRow(runId);
    expect(run.status).toBe("failed");

    const events = await replayRunEvents(testDb.db, runId);
    expect(events).toEqual(expectedEventsFromDb(runId, steps, run));

    // Three failed llm_call attempts → three started/finished pairs, attempts
    // 1/2/3, each finished event carrying the error and NO tokens.
    expect(events.map((event) => event.type)).toEqual([
      "run_started",
      "llm_call_started",
      "llm_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "llm_call_started",
      "llm_call_finished",
      "run_finished",
    ]);
    const finished = events.filter(
      (event): event is Extract<RunEvent, { type: "llm_call_finished" }> =>
        event.type === "llm_call_finished",
    );
    expect(finished.map((event) => event.attempt)).toEqual([1, 2, 3]);
    for (const event of finished) {
      expect(event.error).toContain("overloaded_error");
      expect(event.inputTokens).toBeUndefined();
      expect(event.outputTokens).toBeUndefined();
    }

    // run_finished is the failed bracket, carrying the run's error.
    const runFinished = events.at(-1)!;
    expect(runFinished.type).toBe("run_finished");
    if (runFinished.type === "run_finished") {
      expect(runFinished.status).toBe("failed");
      expect(runFinished.error).toContain("overloaded_error");
    }
  });
});

// --- Unknown run: empty stream ------------------------------------------------

describe("replayRunEvents — unknown run", () => {
  it("returns an empty array for a run id that does not exist", async () => {
    expect(await replayRunEvents(testDb.db, "run_does_not_exist")).toEqual([]);
  });
});
