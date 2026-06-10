import { renderPolicyMarkdown } from "@loopp/agent";
import { count } from "drizzle-orm";
import { customers, orderItems, orders, refunds } from "@loopp/db";
import { publicProcedure, router } from "../trpc";

export const systemRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, time: new Date() })),

  /**
   * The customer-facing refund policy as markdown, rendered from the rule data
   * in @loopp/agent — byte-identical to docs/refund-policy.md (guaranteed by
   * the agent render sync test), NOT read from disk, so server→agent layering
   * stays one-way. The UI renders this as escaped text.
   */
  policy: publicProcedure.query(() => ({ markdown: renderPolicyMarkdown() })),

  stats: publicProcedure.query(async ({ ctx }) => {
    const [c] = await ctx.db.select({ n: count() }).from(customers);
    const [o] = await ctx.db.select({ n: count() }).from(orders);
    const [i] = await ctx.db.select({ n: count() }).from(orderItems);
    const [r] = await ctx.db.select({ n: count() }).from(refunds);
    return {
      customers: c?.n ?? 0,
      orders: o?.n ?? 0,
      orderItems: i?.n ?? 0,
      refunds: r?.n ?? 0,
    };
  }),
});
