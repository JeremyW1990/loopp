import {
  AgentRunFailedError,
  ConversationNotFoundError,
  MissingApiKeyError,
  replayRunEvents,
  runAgentTurn,
  type RunEvent,
} from "@loopp/agent";
import { agentRuns } from "@loopp/db";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

/**
 * Stable de-dupe key for a RunEvent. Live and replayed streams assign IDENTICAL
 * seqs (run_started=0, both *_started/*_finished of a step share the row's seq,
 * run_finished=the last step's seq), and a step emits exactly one event of each
 * type — so (type, seq) is unique within one complete stream and lets the
 * subscription emit the replay catch-up then the live tail without double-firing
 * any event that straddles the boundary.
 */
function eventKey(event: RunEvent): string {
  return `${event.type}:${event.seq}`;
}

export const chatRouter = router({
  /**
   * One user turn through the agent loop → { runId, reply }. The router is
   * transport-thin: validate, call runAgentTurn, map the loop's typed errors
   * to TRPC codes. The loop resolves the LLM client before any DB write, so
   * the missing-key and unknown-conversation failures leave zero rows.
   */
  sendMessage: publicProcedure
    .input(
      z
        .object({
          conversationId: z.string().min(1).max(64),
          text: z.string().min(1).max(2000),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const { runId, reply } = await runAgentTurn(
          ctx.agent,
          input.conversationId,
          input.text,
        );
        return { runId, reply };
      } catch (error) {
        if (error instanceof MissingApiKeyError) {
          // The message names the exact fix (add the key to .env, restart).
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: error.message,
            cause: error,
          });
        }
        if (error instanceof ConversationNotFoundError) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: error.message,
            cause: error,
          });
        }
        if (error instanceof AgentRunFailedError) {
          // The run row exists (finalized 'failed'); no assistant message was
          // persisted — say only what happened, and point at the trace.
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: `The agent could not complete this turn (run ${error.runId}). Please try again.`,
            cause: error,
          });
        }
        throw error;
      }
    }),

  /**
   * Live run-activity stream for one runId, as a v11 SSE subscription (async
   * generator → status chips in the browser). Transport-thin: all event
   * construction lives in @loopp/agent (the bus + replayRunEvents); this only
   * orchestrates subscribe / replay / de-dupe / abort.
   *
   * Race-safe ordering (a run can finish between the status read and the bus
   * subscribe, which would drop the tail): subscribe to the live bus FIRST so
   * nothing emitted from here on is missed, THEN read the run row.
   *   - Not running → replay the persisted trace and return (late subscriber /
   *     reload path; the run is closed, the bus would never emit again).
   *   - Running → replay the events already persisted as catch-up, then forward
   *     live bus events, de-duped by (type, seq) so an event that landed in BOTH
   *     the replay catch-up and the buffered live tail fires exactly once. The
   *     stream ends on run_finished or client abort (signal unsubscribes).
   */
  runEvents: publicProcedure
    .input(z.object({ runId: z.string().min(1).max(64) }).strict())
    .subscription(async function* ({ ctx, input, signal }) {
      const { runId } = input;

      // Subscribe to the live bus BEFORE reading status — closes the finish race.
      const live = ctx.agent.events?.events(runId, signal);

      const runRows = await ctx.db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);
      const run = runRows[0];

      // Unknown or already-finished run: replay the persisted trace and stop.
      // (replayRunEvents returns [] for an unknown id.) Drop the live iterator
      // we opened — its finally clause unsubscribes.
      if (run === undefined || run.status !== "running") {
        await live?.return?.(undefined);
        for (const event of await replayRunEvents(ctx.db, runId)) {
          yield event;
        }
        return;
      }

      // In-flight run. Replay what's persisted so far as catch-up, tracking the
      // (type, seq) of every event we emit so the live tail doesn't repeat it.
      // replayRunEvents always BRACKETS its output with run_finished (derived
      // from the run row) — but a still-running run has not finished, so that
      // bracket is premature here. Skip it: the real terminal arrives on the
      // live bus below. (The status read above + subscribe-first guarantee we
      // see it; a run that finished in the meantime emits run_finished into the
      // bus, which the live loop forwards.)
      const seen = new Set<string>();
      for (const event of await replayRunEvents(ctx.db, runId)) {
        if (event.type === "run_finished") continue;
        seen.add(eventKey(event));
        yield event;
      }

      // Forward live events until run_finished (inclusive) or abort. The bus
      // iterator buffers events emitted before/between pulls, so the head and
      // middle are never dropped; identical seqs to the replay let us skip
      // anything already surfaced above.
      if (live === undefined) return;
      for await (const event of live) {
        const key = eventKey(event);
        if (seen.has(key)) continue;
        seen.add(key);
        yield event;
        if (event.type === "run_finished") return;
      }
    }),
});
