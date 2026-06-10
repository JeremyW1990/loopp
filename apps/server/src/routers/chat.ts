import {
  AgentRunFailedError,
  ConversationNotFoundError,
  MissingApiKeyError,
  runAgentTurn,
} from "@loopp/agent";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

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
});
