// ---------------------------------------------------------------------------
// The agent loop — an explicit state machine behind
// runAgentTurn(deps, conversationId, userText) → { runId, reply }.
//
// The order of operations is load-bearing:
//   1. deps.getLlm() resolves FIRST — on keyless setups MissingApiKeyError
//      propagates before ANY DB write, so no orphan messages or runs.
//   2. The conversations row is the session identity: its customerId becomes
//      ToolContext.customerId. Tools never accept identity from the model.
//   3. user message → agent_runs(running) → traced loop → assistant message
//      persisted ONLY on success (say only what happened) → finalizeRun in a
//      finally block, so totals/cost/duration land on completion AND failure.
//
// Retry policy: the real LlmClient is constructed with maxRetries: 0, so the
// loop owns retries — each LLM attempt is its own llm_call agent_steps row
// (a retry is a NEW row, same name, attempt + 1). A run makes at most
// MAX_LLM_CALLS_PER_RUN LLM calls (retries excluded), each retried at most
// twice on retryable provider errors with exponential backoff through the
// injectable sleep (tests pass a recorder, production waits for real).
//
// History is rebuilt per turn from persisted messages as plain text
// user/assistant turns — intra-turn tool_use/tool_result blocks are not
// replayed into later turns (sufficient for T3; revisit if T6 needs more).
// ---------------------------------------------------------------------------

import { agentRuns, conversations, messages, type Db } from "@loopp/db";
import { newId } from "@loopp/shared";
import { asc, eq } from "drizzle-orm";
import type { RunEvent, RunEventBus } from "./events";
import type { MockPaymentGateway } from "./gateway";
import {
  LlmCallError,
  type LlmClient,
  type LlmContentBlock,
  type LlmMessage,
  type LlmRequest,
  type LlmResponse,
  type LlmToolUseBlock,
} from "./llm";
import { computeCostUsd } from "./pricing";
import { buildSystemPrompt } from "./system-prompt";
import { createRunTracer, type RunTracer } from "./trace";
import { AGENT_TOOL_DEFINITIONS, executeTool, type ToolContext } from "./tools";

// --- Dependencies & results ---------------------------------------------------

export interface AgentDeps {
  db: Db;
  /**
   * Lazy LLM factory. Called before any DB write so a MissingApiKeyError on
   * keyless setups leaves zero rows behind. Tests inject a scripted client.
   */
  getLlm: () => LlmClient;
  /** Model id sent on every request and stored on agent_runs/llm_call steps. */
  model: string;
  gateway: MockPaymentGateway;
  /** Injectable clock (business timestamps + eligibility checks). */
  now?: () => Date;
  /** Injectable backoff — tests record calls instead of waiting. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Optional live run-event bus. When present, the loop emits a RunEvent for
   * every lifecycle boundary it crosses — run_started, the per-step events the
   * tracer derives (see trace.ts), and run_finished — keyed by runId. Omitted
   * by keyless tests and harnesses; the run behaves identically without it.
   */
  events?: RunEventBus;
}

export interface AgentTurnResult {
  runId: string;
  reply: string;
}

/** The conversation id does not exist — thrown before any DB write. */
export class ConversationNotFoundError extends Error {
  readonly conversationId: string;

  constructor(conversationId: string) {
    super(`Conversation "${conversationId}" not found`);
    this.name = "ConversationNotFoundError";
    this.conversationId = conversationId;
  }
}

/**
 * The run started (agent_runs row exists, finalized as status 'failed') but
 * produced no reply — LLM retries exhausted, the iteration cap was hit, or an
 * unexpected stop reason surfaced. No assistant message was persisted.
 */
export class AgentRunFailedError extends Error {
  readonly runId: string;

  constructor(runId: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentRunFailedError";
    this.runId = runId;
  }
}

// --- Loop constants -------------------------------------------------------------

/** Hard cap on LLM calls per run (retries of a single call excluded). */
export const MAX_LLM_CALLS_PER_RUN = 10;

/** One initial attempt plus at most two retries on retryable provider errors. */
const MAX_LLM_ATTEMPTS_PER_CALL = 3;

/** Exponential backoff base: 500ms, then 1000ms. */
const LLM_RETRY_BACKOFF_MS = 500;

/**
 * Output cap per LLM call. Refund-support replies are deliberately short; a
 * tight cap bounds the cost of a degenerate rambling response without ever
 * touching a realistic turn (tool calls + a few sentences of text).
 */
const MAX_OUTPUT_TOKENS = 4096;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chat history is replayed in messages.createdAt order, but Date has only
// millisecond precision and a mocked LLM turn can complete in well under a
// millisecond — two messages with equal timestamps would replay in random
// (id) order. This process-wide monotonic clamp guarantees every message
// this process writes gets a strictly later timestamp than the previous one.
let lastMessageTimestampMs = 0;

function nextMessageTimestamp(now: () => Date): Date {
  const candidate = now().getTime();
  lastMessageTimestampMs =
    candidate > lastMessageTimestampMs ? candidate : lastMessageTimestampMs + 1;
  return new Date(lastMessageTimestampMs);
}

// --- The turn -------------------------------------------------------------------

export async function runAgentTurn(
  deps: AgentDeps,
  conversationId: string,
  userText: string,
): Promise<AgentTurnResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;

  // 1) Resolve the LLM client before touching the database: a missing API key
  //    must fail the turn without leaving an orphan user message or run row.
  const llm = deps.getLlm();

  // 2) The conversation row is the session identity — customerId comes from
  //    here and ONLY here, never from model input.
  const conversationRows = await deps.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);
  const conversation = conversationRows[0];
  if (conversation === undefined) {
    throw new ConversationNotFoundError(conversationId);
  }

  // 3) Persist the user's turn.
  await deps.db.insert(messages).values({
    id: newId("msg"),
    conversationId,
    role: "user",
    content: userText,
    createdAt: nextMessageTimestamp(now),
  });

  // 4) Open the run.
  const runId = newId("run");
  const startedClock = performance.now();
  await deps.db.insert(agentRuns).values({
    id: runId,
    conversationId,
    status: "running",
    model: deps.model,
    startedAt: now(),
  });

  // Bind the optional bus to this run's channel. The tracer derives the
  // per-step events (started/finished/guardrail) from its single write path so
  // deep guardrail rows surface; the loop emits only the run brackets here.
  const emit = deps.events
    ? (event: RunEvent) => deps.events!.emit(runId, event)
    : undefined;
  // run_started carries seq 0 — emitted before the tracer assigns any per-step
  // seq, matching exactly what replayRunEvents prepends for a finished run.
  emit?.({ type: "run_started", runId, seq: 0 });

  const tracer = createRunTracer(deps.db, runId, emit);
  const toolCtx: ToolContext = {
    db: deps.db,
    conversationId,
    customerId: conversation.customerId,
    runId,
    now,
    gateway: deps.gateway,
    recordStep: tracer.recordStep,
  };

  // 5) Rebuild the transcript from persisted messages (includes the user
  //    message just written) — chronological, text turns only.
  const historyRows = await deps.db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt), asc(messages.id));
  const transcript: LlmMessage[] = historyRows.map((row) => ({
    role: row.role,
    content: [{ type: "text", text: row.content }],
  }));

  const system = buildSystemPrompt();

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let status: "completed" | "failed" = "failed";
  let failure: string | undefined;

  try {
    for (let iteration = 1; iteration <= MAX_LLM_CALLS_PER_RUN; iteration += 1) {
      const request: LlmRequest = {
        model: deps.model,
        maxTokens: MAX_OUTPUT_TOKENS,
        system,
        tools: [...AGENT_TOOL_DEFINITIONS],
        // Snapshot: the transcript array keeps growing; the request must
        // capture this iteration's view (also keeps mock-recorded requests
        // stable for test assertions).
        messages: [...transcript],
      };

      const response = await callLlmWithRetries({
        llm,
        request,
        iteration,
        tracer,
        model: deps.model,
        now,
        sleep,
      });
      totalInputTokens += response.usage.inputTokens;
      totalOutputTokens += response.usage.outputTokens;

      if (response.stopReason === "tool_use") {
        const toolUses = response.content.filter(
          (block): block is LlmToolUseBlock => block.type === "tool_use",
        );
        if (toolUses.length === 0) {
          throw new Error(
            'LLM returned stop reason "tool_use" without any tool_use block',
          );
        }

        transcript.push({ role: "assistant", content: response.content });

        // Execute every requested tool; ALL results go back in ONE user turn.
        // executeTool never throws on bad model input — failures come back as
        // structured outputs flagged isError, mirrored onto the result block.
        const results: LlmContentBlock[] = [];
        for (const toolUse of toolUses) {
          const execution = await executeTool(toolUse.name, toolUse.input, toolCtx);
          results.push({
            type: "tool_result",
            toolUseId: toolUse.id,
            content: JSON.stringify(execution.output),
            isError: execution.isError,
          });
        }
        transcript.push({ role: "user", content: results });
        continue;
      }

      if (response.stopReason === "end_turn") {
        const reply = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n\n");

        // Persisted ONLY on success — the reply must match DB state, so a
        // failed run never gets an assistant message claiming otherwise.
        await deps.db.insert(messages).values({
          id: newId("msg"),
          conversationId,
          role: "assistant",
          content: reply,
          runId,
          createdAt: nextMessageTimestamp(now),
        });

        status = "completed";
        return { runId, reply };
      }

      // No streaming, no server tools, no stop sequences: anything else is a
      // protocol violation. Failing honestly beats persisting a reply the
      // model never finished ("say only what happened").
      throw new Error(`LLM returned unexpected stop reason "${response.stopReason}"`);
    }

    throw new Error(
      `Run exceeded the maximum of ${MAX_LLM_CALLS_PER_RUN} LLM calls without completing`,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw new AgentRunFailedError(runId, failure, { cause: error });
  } finally {
    // Totals land on completion AND failure — the trace is never half-written.
    await tracer.finalizeRun({
      status,
      error: failure,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      costUsd: computeCostUsd(deps.model, totalInputTokens, totalOutputTokens),
      durationMs: Math.round(performance.now() - startedClock),
      finishedAt: now(),
    });
    // run_finished closes the live stream on BOTH completion and failure. seq
    // mirrors the final step's seq (the tracer's last value) so it matches the
    // bracket replayRunEvents appends for the same finished run.
    emit?.({
      type: "run_finished",
      runId,
      seq: tracer.currentSeq(),
      status,
      ...(failure !== undefined ? { error: failure } : {}),
    });
  }
}

// --- LLM call with per-attempt tracing -------------------------------------------

interface LlmCallArgs {
  llm: LlmClient;
  request: LlmRequest;
  iteration: number;
  tracer: RunTracer;
  model: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

/**
 * One logical LLM call: up to MAX_LLM_ATTEMPTS_PER_CALL attempts, each
 * bracketed into its own llm_call agent_steps row. Successful attempts carry
 * per-attempt tokens and the {stopReason, content} output; failed attempts
 * carry the error and no tokens. Only LlmCallError.retryable triggers a
 * retry; the last failure (or any permanent one) propagates to fail the run.
 */
async function callLlmWithRetries(args: LlmCallArgs): Promise<LlmResponse> {
  // What the admin trace shows as the call's input: which iteration this is
  // and a shape-summary of the newest transcript entry. Full tool payloads
  // already live on their own tool_call rows — no need to duplicate them.
  const stepInput = {
    iteration: args.iteration,
    messageCount: args.request.messages.length,
    appended: summarizeMessage(args.request.messages.at(-1)),
  };

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS_PER_CALL; attempt += 1) {
    const startedAt = args.now();
    const startedClock = performance.now();
    try {
      const response = await args.llm.createMessage(args.request);
      await args.tracer.recordStep({
        type: "llm_call",
        name: args.model,
        attempt,
        input: stepInput,
        output: { stopReason: response.stopReason, content: response.content },
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        durationMs: Math.round(performance.now() - startedClock),
        startedAt,
      });
      return response;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryable = error instanceof LlmCallError && error.retryable;
      await args.tracer.recordStep({
        type: "llm_call",
        name: args.model,
        attempt,
        input: stepInput,
        error: message,
        durationMs: Math.round(performance.now() - startedClock),
        startedAt,
      });
      if (retryable && attempt < MAX_LLM_ATTEMPTS_PER_CALL) {
        await args.sleep(LLM_RETRY_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw error;
    }
  }

  // The loop above always returns or throws; this satisfies control flow.
  throw new Error("callLlmWithRetries: unreachable");
}

/** Compact, JSON-safe shape description of one transcript message. */
function summarizeMessage(message: LlmMessage | undefined) {
  if (message === undefined) return null;
  return {
    role: message.role,
    blocks: message.content.map((block) => {
      switch (block.type) {
        case "text":
          return { type: "text" as const, chars: block.text.length };
        case "tool_use":
          return { type: "tool_use" as const, name: block.name };
        case "tool_result":
          return {
            type: "tool_result" as const,
            toolUseId: block.toolUseId,
            isError: block.isError === true,
          };
      }
    }),
  };
}
