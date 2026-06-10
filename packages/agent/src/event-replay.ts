// ---------------------------------------------------------------------------
// Event replay — the persisted half of agent observability.
//
// The live event bus (events.ts) only fans out while a run is in flight. Once a
// run finishes, a late subscriber or a page reload has nothing to listen to —
// so replayRunEvents reconstructs an EQUIVALENT RunEvent stream from the
// agent_steps the loop already wrote. The server's chat.runEvents subscription
// forwards live bus events for a running run and replays these for a finished
// one, so both paths render identical status chips.
//
// The reconstruction is mechanical and 1:1 with the trace:
//   - each agent_steps row of type llm_call / tool_call expands to its
//     *_started + *_finished pair (the finished event carries the row's
//     attempt, durationMs, tokens, and error);
//   - a guardrail row expands to a single guardrail event;
//   - the stream is bracketed by run_started (before any step) and
//     run_finished (derived from the agent_runs row's status/error).
//
// Every event mirrors the SAME seq the live path would assign — the source
// row's seq for per-step events, 0 for run_started (emitted before the first
// step), and the final step's seq for run_finished (the tracer's next
// monotonic value) — so the live tail and a replay are de-duplicable by seq.
//
// Pure read: parameterized Drizzle only, no API key, no network, no mutation.
// ---------------------------------------------------------------------------

import { agentRuns, agentSteps, type Db } from "@loopp/db";
import { asc, eq } from "drizzle-orm";
import type { RunEvent } from "./events";

/**
 * Reconstruct the ordered RunEvent stream for a finished (or in-progress) run
 * from its persisted agent_steps + agent_runs rows. Returns an empty array if
 * the run id is unknown.
 *
 * Status-chip granularity only — names, attempts, durations, token counts, and
 * errors — matching what the live bus carries; full LLM content and raw tool
 * I/O stay in agent_steps for the admin trace (T5).
 */
export async function replayRunEvents(db: Db, runId: string): Promise<RunEvent[]> {
  const runRows = await db
    .select()
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  const run = runRows[0];
  if (run === undefined) return [];

  const stepRows = await db
    .select()
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(asc(agentSteps.seq));

  const events: RunEvent[] = [];

  // run_started brackets the stream before the first step; seq 0 mirrors the
  // live path, which emits it right after the agent_runs(running) insert and
  // before the tracer assigns any per-step seq.
  events.push({ type: "run_started", runId, seq: 0 });

  for (const step of stepRows) {
    switch (step.type) {
      case "llm_call":
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
        break;

      case "tool_call":
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
        break;

      case "guardrail":
        events.push({
          type: "guardrail",
          runId,
          seq: step.seq,
          name: step.name,
        });
        break;
    }
  }

  // run_finished closes the stream. seq mirrors the final step's seq (the
  // tracer's last monotonic value); a run with no steps falls back to 0 so the
  // event still orders after run_started. A still-"running" run replays with a
  // 'completed' bracket — but the server only replays NON-running runs, so in
  // practice status is always completed/failed here.
  const lastSeq = stepRows.length > 0 ? stepRows[stepRows.length - 1]!.seq : 0;
  events.push({
    type: "run_finished",
    runId,
    seq: lastSeq,
    status: run.status === "failed" ? "failed" : "completed",
    ...(run.error !== null ? { error: run.error } : {}),
  });

  return events;
}
