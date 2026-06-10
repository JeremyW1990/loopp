// CLI entry for `pnpm db:seed` (tsx src/seed-cli.ts). All process-level
// concerns live here — env loading, connection lifecycle, exit codes — so
// that importing runSeed from ./seed stays side-effect free.
import { config } from "dotenv";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "./client";
import { runSeed } from "./seed";

config({ path: resolve(process.cwd(), "../../.env") });

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

async function main() {
  const { db, sql: pg } = createDb(DATABASE_URL);

  await runSeed(db);

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
