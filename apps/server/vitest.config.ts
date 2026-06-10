import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // chat.test.ts reseeds and asserts row counts on the single shared compose
    // Postgres; keep test files sequential (mirrors packages/agent).
    fileParallelism: false,
  },
});
