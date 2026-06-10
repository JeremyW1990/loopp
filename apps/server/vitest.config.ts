import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // chat.test.ts reseeds and asserts row counts on the single shared compose
    // Postgres; keep test files sequential (mirrors packages/agent). The root
    // `test` script also pins pnpm --workspace-concurrency=1 so the agent and
    // server packages never hit that one DB at the same time — together these
    // make the whole suite deterministic against the shared Postgres.
    fileParallelism: false,
  },
});
