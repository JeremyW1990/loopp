import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// .env lives at the repo root; every value except ANTHROPIC_API_KEY defaults
// so the server boots against the Compose database with no .env at all.
const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
config({ path: resolve(repoRoot, ".env") });

const envSchema = z.object({
  DATABASE_URL: z
    .string()
    .default("postgresql://loopp:loopp@localhost:5436/loopp"),
  PORT: z.coerce.number().default(4011),
  ANTHROPIC_API_KEY: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
