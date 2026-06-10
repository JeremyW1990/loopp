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
// costUsd is the one floating-point money value in the system; it meets
// storage here, formatted to a fixed 6-decimal string for numeric(12,6).
// ---------------------------------------------------------------------------

import { agentRuns, agentSteps, type Db } from "@loopp/db";
import { eq } from "drizzle-orm";
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
}

export function createRunTracer(db: Db, runId: string): RunTracer {
  let seq = 0;

  return {
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
