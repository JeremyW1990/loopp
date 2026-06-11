import {
  approveEscalatedRefund,
  getAdminStats,
  getRunTrace,
  getSessionRuns,
  getTranscript,
  listChatHistory,
  listEscalations,
  listRuns,
  readFaultInjection,
  RefundNotEscalatedError,
  RefundNotFoundError,
  rejectEscalatedRefund,
  setFaultInjection,
} from "@loopp/agent";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

/**
 * Map the admin-logic typed errors (raised by approve/reject in @loopp/agent)
 * onto TRPC codes, then rethrow anything else untouched. Mirrors chat.ts's
 * error-mapping style and never leaks a raw stack: the message comes from the
 * typed error, the original is attached as `cause`.
 *   - RefundNotFoundError     -> NOT_FOUND  (no row with that id)
 *   - RefundNotEscalatedError -> CONFLICT   (already resolved / never escalated)
 */
function mapRefundError(error: unknown): never {
  if (error instanceof RefundNotFoundError) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: error.message,
      cause: error,
    });
  }
  if (error instanceof RefundNotEscalatedError) {
    throw new TRPCError({
      code: "CONFLICT",
      message: error.message,
      cause: error,
    });
  }
  throw error;
}

/**
 * The admin observability + human-in-the-loop surface, transport-thin: every
 * procedure zod-validates its input (.strict()), delegates to a pure function
 * in @loopp/agent over ctx.db / ctx.agent, and returns. No business logic lives
 * here — approve/reject (the authority boundary) and the trace/escalation/stats
 * assembly are all in @loopp/agent, so they stay testable offline with the mock
 * gateway and never depend on the express/tRPC stack.
 */
export const adminRouter = router({
  /** All agent runs (newest first) with their conversation's customer. */
  runs: publicProcedure.query(({ ctx }) => listRuns(ctx.db)),

  /** The agent runs for one session (conversation), newest first. */
  sessionRuns: publicProcedure
    .input(z.object({ conversationId: z.string().min(1).max(64) }).strict())
    .query(({ ctx, input }) => getSessionRuns(ctx.db, input.conversationId)),

  /**
   * One run's header + its agent_steps verbatim in strict seq order. An unknown
   * runId yields null from the logic layer → NOT_FOUND here (the viewer never
   * fabricates a trace for a missing run).
   */
  trace: publicProcedure
    .input(z.object({ runId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const trace = await getRunTrace(ctx.db, input.runId);
      if (trace === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Run "${input.runId}" not found`,
        });
      }
      return trace;
    }),

  /**
   * Chat history grouped by customer (user) → conversation (session), each with
   * message counts + an opening-message preview. Newest session first.
   */
  chatHistory: publicProcedure.query(({ ctx }) => listChatHistory(ctx.db)),

  /**
   * One session's full transcript (user + assistant messages in time order).
   * Unknown conversationId yields null from the logic layer → NOT_FOUND here.
   */
  transcript: publicProcedure
    .input(z.object({ conversationId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const transcript = await getTranscript(ctx.db, input.conversationId);
      if (transcript === null) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Conversation "${input.conversationId}" not found`,
        });
      }
      return transcript;
    }),

  /** The refunds awaiting human review (status='escalated'), newest first. */
  escalations: publicProcedure.query(({ ctx }) => listEscalations(ctx.db)),

  /** Aggregate dashboard stats over agent_runs and the escalation queue. */
  stats: publicProcedure.query(({ ctx }) => getAdminStats(ctx.db)),

  /** Read + write the live fault-injection (chaos) toggle. */
  faultInjection: router({
    get: publicProcedure.query(({ ctx }) => readFaultInjection(ctx.db)),
    set: publicProcedure
      .input(z.object({ enabled: z.boolean() }).strict())
      .mutation(({ ctx, input }) => setFaultInjection(ctx.db, input.enabled)),
  }),

  /**
   * Approve a >$500 escalated refund — the ONLY path that resolves an escalation
   * to 'approved'. Delegates to the authority-boundary core, which moves money
   * through the SAME shared gateway (refund id = idempotency key, exactly-once
   * under double-click/replay) before the status-guarded write. Typed errors map
   * to NOT_FOUND / CONFLICT.
   */
  approveRefund: publicProcedure
    .input(z.object({ refundId: z.string().min(1).max(64) }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        return await approveEscalatedRefund(ctx.agent, input.refundId);
      } catch (error) {
        mapRefundError(error);
      }
    }),

  /**
   * Reject an escalated refund with a required, non-empty admin note (the zod
   * .min(1) rejects empty/missing notes as BAD_REQUEST before any write). No
   * money moves; a rejected refund frees its items for a future refund. Typed
   * errors map to NOT_FOUND / CONFLICT.
   */
  rejectRefund: publicProcedure
    .input(
      z
        .object({
          refundId: z.string().min(1).max(64),
          adminNote: z.string().min(1).max(2000),
        })
        .strict(),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await rejectEscalatedRefund(
          ctx.agent,
          input.refundId,
          input.adminNote,
        );
      } catch (error) {
        mapRefundError(error);
      }
    }),
});
