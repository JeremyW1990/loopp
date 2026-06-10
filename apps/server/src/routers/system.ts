import { count } from "drizzle-orm";
import { customers, orderItems, orders, refunds } from "@loopp/db";
import { publicProcedure, router } from "../trpc";

export const systemRouter = router({
  ping: publicProcedure.query(() => ({ ok: true, time: new Date() })),

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
