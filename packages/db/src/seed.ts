import { config } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import {
  appSettings,
  customers,
  orderItems,
  orders,
  refunds,
} from "./schema";
import { SEED_CUSTOMERS, SEED_ORDERS, SEED_REFUNDS } from "./seed-data";

config({ path: resolve(process.cwd(), "../../.env") });

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

function daysAgo(days: number): Date {
  const d = new Date(Date.now() - days * 86_400_000);
  if (days === 0) d.setTime(Date.now() - 4 * 3_600_000); // "today" = 4h ago
  return d;
}

function itemSubtotalCents(items: { unitPriceCents: number; quantity: number }[]): number {
  return items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
}

async function main() {
  const { db, sql: pg } = createDb(DATABASE_URL);

  await db.execute(sql`
    TRUNCATE TABLE agent_steps, agent_runs, messages, conversations,
      refunds, order_items, orders, customers, app_settings
    RESTART IDENTITY CASCADE
  `);

  await db.insert(customers).values(
    SEED_CUSTOMERS.map((c) => ({
      id: c.id,
      name: c.name,
      email: c.email,
      joinedAt: daysAgo(c.joinedDaysAgo),
    })),
  );

  await db.insert(orders).values(
    SEED_ORDERS.map((o) => ({
      id: o.id,
      customerId: o.customerId,
      status: o.status,
      orderedAt: daysAgo(o.orderedDaysAgo),
      deliveredAt:
        o.deliveredDaysAgo === undefined ? null : daysAgo(o.deliveredDaysAgo),
      shippingCents: o.shippingCents,
      totalCents: itemSubtotalCents(o.items) + o.shippingCents,
    })),
  );

  await db.insert(orderItems).values(
    SEED_ORDERS.flatMap((o) =>
      o.items.map((i) => ({
        id: i.id,
        orderId: o.id,
        name: i.name,
        category: i.category,
        unitPriceCents: i.unitPriceCents,
        quantity: i.quantity,
        isFinalSale: i.isFinalSale ?? false,
      })),
    ),
  );

  const itemPriceById = new Map(
    SEED_ORDERS.flatMap((o) =>
      o.items.map((i) => [i.id, i.unitPriceCents * i.quantity] as const),
    ),
  );

  await db.insert(refunds).values(
    SEED_REFUNDS.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      customerId: r.customerId,
      amountCents: r.itemIds.reduce(
        (sum, id) => sum + (itemPriceById.get(id) ?? 0),
        0,
      ),
      itemIds: r.itemIds,
      reason: r.reason,
      status: r.status,
      decidedBy: r.decidedBy,
      gatewayRef: `gw_seed_${r.id}`,
      createdAt: daysAgo(r.createdDaysAgo),
      resolvedAt: daysAgo(r.createdDaysAgo),
    })),
  );

  await db.insert(appSettings).values([
    { key: "fault_injection", value: false },
  ]);

  const counts = await db.execute(sql`
    SELECT
      (SELECT count(*) FROM customers)   AS customers,
      (SELECT count(*) FROM orders)      AS orders,
      (SELECT count(*) FROM order_items) AS items,
      (SELECT count(*) FROM refunds)     AS refunds
  `);
  console.log("Seed complete:", counts[0]);

  await pg.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
