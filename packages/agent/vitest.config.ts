import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // DB-backed suites (tools, loop) share the single compose Postgres and
    // reseed in beforeAll; parallel files would race on the same tables.
    fileParallelism: false,
  },
});
