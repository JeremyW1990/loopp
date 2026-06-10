import { customers } from "@loopp/db";
import { asc } from "drizzle-orm";
import { publicProcedure, router } from "../trpc";

export const customersRouter = router({
  /** Identity picker for the demo UI: every seeded customer, ordered by id. */
  list: publicProcedure.query(({ ctx }) =>
    ctx.db
      .select({ id: customers.id, name: customers.name, email: customers.email })
      .from(customers)
      .orderBy(asc(customers.id)),
  ),
});
