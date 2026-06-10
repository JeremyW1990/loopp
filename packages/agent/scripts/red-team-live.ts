// ---------------------------------------------------------------------------
// LIVE red-team CLI — the ONLY entry point in this repository that constructs
// the real Anthropic client and spends tokens. Run with `pnpm red-team`
// (= pnpm --filter @loopp/agent red-team → tsx scripts/red-team-live.ts).
//
// It is deliberately a thin process wrapper, NOT a *.test.ts file, so vitest /
// CI never import it and `pnpm test` stays fully offline (the harness CORE in
// src/red-team.ts is exercised keyless by src/red-team.test.ts with a scripted
// LLM). All process-level concerns live HERE — env loading, the API-key gate,
// the DB connection lifecycle, the non-zero exit code — exactly mirroring
// packages/db/src/seed-cli.ts so a reviewer recognizes the shape.
//
// What it does, in order:
//   1. Load repo-root .env (dotenv), like seed-cli.ts.
//   2. Gate on ANTHROPIC_API_KEY: blank/absent → print the exact friendly fix
//      and exit(1). The key is NEVER printed (only its presence is reported).
//   3. Open the compose DB (DATABASE_URL or the local default).
//   4. Build AgentDeps with the real client (createAnthropicLlmClient), the
//      model from ANTHROPIC_MODEL (default claude-sonnet-4-6), and a fresh
//      MockPaymentGateway. No events bus — the harness reads the DB, not SSE.
//   5. runRedTeam(deps, RED_TEAM_SCENARIOS, { reseed: true }) — reseed before
//      the suite (seed dates are relative to seed time), drive every scripted
//      multi-turn attack through the REAL loop, then assert what the DB holds.
//   6. Print the pure formatReport() table, close the pool, and
//      process.exit(report.failed > 0 ? 1 : 0) so CI/callers see the verdict.
//
// This file constructs no policy or money logic; every monetary fact in the
// report comes from the ledger the real tools wrote. The agent package still
// never imports express/tRPC.
// ---------------------------------------------------------------------------

import { resolve } from "node:path";
import { config } from "dotenv";
import { createDb } from "@loopp/db";
import { createAnthropicLlmClient } from "../src/llm";
import { MockPaymentGateway } from "../src/gateway";
import type { AgentDeps } from "../src/loop";
import {
  RED_TEAM_SCENARIOS,
  formatReport,
  runRedTeam,
} from "../src/red-team";

// Repo-root .env — resolved from cwd exactly like seed-cli.ts. `pnpm red-team`
// runs this from the @loopp/agent package dir (packages/agent), so ../../.env
// is the repository root.
config({ path: resolve(process.cwd(), "../../.env") });

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";
const MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6";

async function main(): Promise<number> {
  // --- API-key gate (never prints the key) ---------------------------------
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      [
        "red-team: ANTHROPIC_API_KEY is not set.",
        "",
        "This is the LIVE adversarial suite — it drives the real agent loop",
        "against the Anthropic API, so it needs a key:",
        "",
        "  1. cp .env.example .env   (if you have not already)",
        "  2. Add your key:   ANTHROPIC_API_KEY=sk-ant-...",
        "  3. Re-run:         pnpm red-team",
        "",
        "Note: `pnpm test` is fully offline and needs NO key — the harness",
        "logic is unit-tested there with a scripted model.",
      ].join("\n"),
    );
    return 1;
  }

  console.log(
    `red-team: ANTHROPIC_API_KEY present; model=${MODEL}; db=${DATABASE_URL}`,
  );
  console.log(
    `red-team: running ${RED_TEAM_SCENARIOS.length} live adversarial scenarios ` +
      "through the REAL agent loop (this spends tokens)...\n",
  );

  // --- Connection + deps ----------------------------------------------------
  const { db, sql } = createDb(DATABASE_URL);
  const deps: AgentDeps = {
    db,
    // Real client, constructed ONLY here. maxRetries:0 lives inside the wrapper
    // so each attempt is its own trace row (see llm.ts header).
    getLlm: () => createAnthropicLlmClient({ apiKey }),
    model: MODEL,
    // Fresh in-memory gateway: real tool path, no external payment processor.
    gateway: new MockPaymentGateway(),
    // No events bus — the suite asserts persisted DB state, not live SSE.
  };

  try {
    const report = await runRedTeam(deps, RED_TEAM_SCENARIOS, { reseed: true });
    console.log(formatReport(report));
    // Non-zero on ANY scenario or invariant-sweep failure.
    return report.failed > 0 ? 1 : 0;
  } finally {
    await sql.end();
  }
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    // An unexpected throw (provider outage, connection refused, a bug) is a
    // hard failure: surface it and exit non-zero so CI/callers never read a
    // crash as a pass.
    console.error("red-team: suite crashed:", err);
    process.exit(1);
  });
