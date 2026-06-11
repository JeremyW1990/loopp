import {
  conversations,
  customers,
  messages,
  orderItems,
  orders,
  refunds,
} from "@loopp/db";
import { newId } from "@loopp/shared";
import { TRPCError } from "@trpc/server";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../trpc";

export const conversationRouter = router({
  /** Start a chat session for an existing customer → { conversationId }. */
  create: publicProcedure
    .input(z.object({ customerId: z.string().min(1).max(64) }).strict())
    .mutation(async ({ ctx, input }) => {
      const found = await ctx.db
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, input.customerId))
        .limit(1);
      if (found.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Customer "${input.customerId}" not found`,
        });
      }

      const conversationId = newId("conv");
      await ctx.db.insert(conversations).values({
        id: conversationId,
        customerId: input.customerId,
        createdAt: new Date(),
      });
      return { conversationId };
    }),

  /**
   * Full message history, ordered exactly as the agent loop replays it
   * (createdAt asc, id asc tiebreaker).
   */
  messages: publicProcedure
    .input(z.object({ conversationId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const found = await ctx.db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      if (found.length === 0) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Conversation "${input.conversationId}" not found`,
        });
      }

      return ctx.db
        .select({
          id: messages.id,
          role: messages.role,
          content: messages.content,
          runId: messages.runId,
          createdAt: messages.createdAt,
        })
        .from(messages)
        .where(eq(messages.conversationId, input.conversationId))
        .orderBy(asc(messages.createdAt), asc(messages.id));
    }),

  /**
   * The orders + items belonging to the conversation's customer — the chat
   * sidebar's source. Identity is SESSION-SCOPED: customerId is read from the
   * conversation row, never from input, so this query can only ever surface the
   * bound customer's data. Unknown conversation → NOT_FOUND. A customer with no
   * orders (cus_010) returns an empty array. Money stays integer cents; the UI
   * formats with formatCents.
   */
  orders: publicProcedure
    .input(z.object({ conversationId: z.string().min(1).max(64) }).strict())
    .query(async ({ ctx, input }) => {
      const conversationRows = await ctx.db
        .select({ customerId: conversations.customerId })
        .from(conversations)
        .where(eq(conversations.id, input.conversationId))
        .limit(1);
      const conversation = conversationRows[0];
      if (conversation === undefined) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Conversation "${input.conversationId}" not found`,
        });
      }

      const orderRows = await ctx.db
        .select({
          id: orders.id,
          status: orders.status,
          orderedAt: orders.orderedAt,
          deliveredAt: orders.deliveredAt,
          shippingCents: orders.shippingCents,
          totalCents: orders.totalCents,
        })
        .from(orders)
        .where(eq(orders.customerId, conversation.customerId))
        .orderBy(asc(orders.orderedAt), asc(orders.id));

      if (orderRows.length === 0) return [];

      // One parameterized fetch of all items for this customer's orders, then
      // group in memory — avoids an N+1 over orders.
      const itemRows = await ctx.db
        .select({
          id: orderItems.id,
          orderId: orderItems.orderId,
          name: orderItems.name,
          unitPriceCents: orderItems.unitPriceCents,
          quantity: orderItems.quantity,
          isFinalSale: orderItems.isFinalSale,
        })
        .from(orderItems)
        .innerJoin(orders, eq(orderItems.orderId, orders.id))
        .where(eq(orders.customerId, conversation.customerId))
        .orderBy(asc(orderItems.id));

      const itemsByOrder = new Map<string, Omit<(typeof itemRows)[number], "orderId">[]>();
      for (const { orderId, ...item } of itemRows) {
        const bucket = itemsByOrder.get(orderId);
        if (bucket === undefined) itemsByOrder.set(orderId, [item]);
        else bucket.push(item);
      }

      // Refund state per item is derived from the refunds table — the order and
      // item rows themselves never change when a refund is issued. An item reads
      // as "refunded" once a covering refund has paid out (processed) or been
      // approved by an admin; "pending" while a refund for it is still escalated;
      // and unmarked otherwise (a rejected refund leaves no mark).
      const refundRows = await ctx.db
        .select({ itemIds: refunds.itemIds, status: refunds.status })
        .from(refunds)
        .innerJoin(orders, eq(refunds.orderId, orders.id))
        .where(eq(orders.customerId, conversation.customerId));
      const refundedItemIds = new Set<string>();
      const pendingItemIds = new Set<string>();
      for (const refund of refundRows) {
        const target =
          refund.status === "processed" || refund.status === "approved"
            ? refundedItemIds
            : refund.status === "escalated"
              ? pendingItemIds
              : null;
        if (target) for (const id of refund.itemIds) target.add(id);
      }
      const refundStateFor = (itemId: string): "refunded" | "pending" | null =>
        refundedItemIds.has(itemId)
          ? "refunded"
          : pendingItemIds.has(itemId)
            ? "pending"
            : null;

      return orderRows.map((order) => ({
        ...order,
        items: (itemsByOrder.get(order.id) ?? []).map((item) => ({
          ...item,
          refundState: refundStateFor(item.id),
        })),
      }));
    }),
});
