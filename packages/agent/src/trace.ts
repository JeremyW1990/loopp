// ---------------------------------------------------------------------------
// Run tracer — the single write path for agent observability.
//
// createRunTracer(db, runId) hands out a recordStep that inserts one
// agent_steps row per llm_call / tool_call / guardrail event with a
// monotonically increasing per-run seq, and a finalizeRun that writes the run
// totals (status, tokens, cost, duration) to agent_runs. A retry is a NEW
// row with the same name and attempt + 1 — never an update of the previous
// attempt — so the admin trace shows every attempt that actually happened.
//
// The tracer is ALSO the single emission point for the live run-event bus.
// recordStep is the one place every llm_call / tool_call / guardrail row is
// written — including guardrail rows produced DEEP in the tool layer
// (loadScopedOrder) — so deriving live RunEvents here, from the same seq the
// row gets, guarantees the live stream and a later replay (event-replay.ts)
// can never diverge. Emitting from the loop's executeTool wrapper alone would
// silently drop those deep guardrails. The emit hook is OPTIONAL: keyless
// tests and harnesses that omit the bus construct the tracer without it and
// stay green.
//
// costUsd is the one floating-point money value in the system; it meets
// storage here, formatted to a fixed 6-decimal string for numeric(12,6).
// ---------------------------------------------------------------------------

import { agentRuns, agentSteps, type Db } from "@loopp/db";
import { eq } from "drizzle-orm";
import type { RunEvent } from "./events";
import { formatCostUsd } from "./pricing";

export type AgentStepType = "llm_call" | "tool_call" | "guardrail";

export interface RecordStepInput {
  type: AgentStepType;
  /** Tool name, model name, or guardrail kind (e.g. "order_not_found"). */
  name: string;
  /** 1 for a first attempt; a retry is a NEW row with attempt + 1. */
  attempt?: number;
  input?: unknown;
  output?: unknown;
  /** Populated on failed attempts; the row still persists. */
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  startedAt: Date;
}

export type RecordStep = (step: RecordStepInput) => Promise<void>;

export interface FinalizeRunInput {
  status: "completed" | "failed";
  error?: string;
  /** Token totals summed over ALL attempts, including failed ones. */
  inputTokens: number;
  outputTokens: number;
  /** USD float from computeCostUsd; persisted as a fixed 6-decimal string. */
  costUsd: number;
  durationMs: number;
  finishedAt: Date;
}

export interface RunTracer {
  recordStep: RecordStep;
  /** Written on completion AND failure (callers run it in a finally block). */
  finalizeRun(input: FinalizeRunInput): Promise<void>;
  /**
   * The seq last assigned to an agent_steps row (0 before the first step).
   * The loop reads this to bracket run_finished with the same seq replay uses
   * (the final step's seq), so live and replayed streams de-dupe cleanly.
   */
  currentSeq(): number;
}

/**
 * Optional sink for live run events derived at the single recordStep boundary.
 * The loop binds this to the run's bus channel; the tracer constructs each
 * event with the seq it just assigned, so a started+finished pair (or a single
 * guardrail) mirrors the persisted row 1:1.
 */
export type EmitRunEvent = (event: RunEvent) => void;

/**
 * Translate one persisted step into its live event(s), using the seq the row
 * was just written with. The shape — started+finished pair for llm_call /
 * tool_call, single event for guardrail, optional fields included only when
 * present — matches replayRunEvents EXACTLY, which is what keeps the live tail
 * and a replay de-dupable by seq.
 */
function emitStepEvents(
  emit: EmitRunEvent,
  runId: string,
  seq: number,
  step: RecordStepInput,
): void {
  const attempt = step.attempt ?? 1;
  switch (step.type) {
    case "llm_call":
      emit({ type: "llm_call_started", runId, seq, name: step.name, attempt });
      emit({
        type: "llm_call_finished",
        runId,
        seq,
        name: step.name,
        attempt,
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
        ...(step.inputTokens !== undefined ? { inputTokens: step.inputTokens } : {}),
        ...(step.outputTokens !== undefined ? { outputTokens: step.outputTokens } : {}),
        ...(step.error !== undefined ? { error: step.error } : {}),
      });
      break;
    case "tool_call":
      emit({ type: "tool_call_started", runId, seq, name: step.name, attempt });
      emit({
        type: "tool_call_finished",
        runId,
        seq,
        name: step.name,
        attempt,
        ...(step.durationMs !== undefined ? { durationMs: step.durationMs } : {}),
        ...(step.error !== undefined ? { error: step.error } : {}),
      });
      break;
    case "guardrail":
      emit({ type: "guardrail", runId, seq, name: step.name });
      break;
  }
}

export function createRunTracer(
  db: Db,
  runId: string,
  emit?: EmitRunEvent,
): RunTracer {
  let seq = 0;

  return {
    currentSeq(): number {
      return seq;
    },

    async recordStep(step: RecordStepInput): Promise<void> {
      seq += 1;
      await db.insert(agentSteps).values({
        runId,
        seq,
        type: step.type,
        name: step.name,
        attempt: step.attempt ?? 1,
        input: step.input ?? null,
        output: step.output ?? null,
        error: step.error ?? null,
        inputTokens: step.inputTokens ?? null,
        outputTokens: step.outputTokens ?? null,
        durationMs: step.durationMs ?? null,
        startedAt: step.startedAt,
      });
      // Emit live events AFTER the row is durably written, with the same seq,
      // so a subscriber never sees an event for a step the trace lacks.
      if (emit !== undefined) emitStepEvents(emit, runId, seq, step);
    },

    async finalizeRun(input: FinalizeRunInput): Promise<void> {
      await db
        .update(agentRuns)
        .set({
          status: input.status,
          error: input.error ?? null,
          inputTokens: input.inputTokens,
          outputTokens: input.outputTokens,
          costUsd: formatCostUsd(input.costUsd),
          durationMs: input.durationMs,
          finishedAt: input.finishedAt,
        })
        .where(eq(agentRuns.id, runId));
    },
  };
}
