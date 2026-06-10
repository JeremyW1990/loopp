import { createDb } from "@loopp/db";
import { env } from "./env";

export const { db, sql } = createDb(env.DATABASE_URL);
