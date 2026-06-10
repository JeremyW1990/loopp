// ---------------------------------------------------------------------------
// SSE end-to-end test — drives the chat.runEvents subscription over the REAL
// HTTP transport (the running Express tRPC server, and the Vite proxy in front
// of it when it's up), not through createCaller. This is the wire-level proof
// behind ac-sse-subscription: a tRPC v11 SSE subscription streams run events as
// `text/event-stream`, unbuffered, through the existing Express adapter — no
// WebSocket, and (crucially) the Vite /trpc proxy passes the stream through
// chunk-by-chunk rather than buffering it until the run completes.
//
// It exercises the REPLAY path (a finished run reconstructed from agent_steps),
// which needs NO ANTHROPIC_API_KEY and no LLM call: the test seeds a finished
// run + its steps directly via a DB handle, opens the SSE stream over fetch,
// parses the superjson-encoded `data:` frames, and asserts the run events arrive
// in the exact lifecycle order a live subscriber would see — then cleans up.
//
// The browser's httpSubscriptionLink consumes this identical event-stream via
// EventSource; parsing the frames with fetch here is transport-equivalent and
// avoids depending on a Node EventSource ponyfill. The createCaller-level
// ordering/parity assertions live in chat.test.ts (chat.runEvents).
//
// describe.skipIf: if the dev server isn't reachable (e.g. CI with no servers
// up), the whole suite SKIPS — a live-server e2e must never fail CI. It never
// needs a key, so it does not gate on ANTHROPIC_API_KEY.
// ---------------------------------------------------------------------------

import {
  agentRuns,
  agentSteps,
  conversations,
  createDb,
  type Db,
} from "@loopp/db";
import type { RunEvent } from "@loopp/agent";
import { newId } from "@loopp/shared";
import { eq } from "drizzle-orm";
import superjson from "superjson";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

// Prefer the Vite proxy (:5173) so we assert the SSE survives proxy passthrough;
// fall back to the API directly (:4011). Overridable for other setups.
const PROXY_URL = process.env.E2E_WEB_URL ?? "http://localhost:5173";
const API_URL = process.env.E2E_API_URL ?? "http://localhost:4011";

/** True if `${base}/health` answers 200 within a short timeout. */
async function isUp(base: string): Promise<boolean> {
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Resolve the base URL ONCE at module load (top-level await) so describe.skipIf
// gets a real boolean: the proxy if it's up (the path that matters for the
// "unbuffered through Vite" requirement), else the API directly, else null →
// the suite SKIPS (CI with no servers up never fails on this live-only e2e).
const baseUrl: string | null = (await isUp(PROXY_URL))
  ? PROXY_URL
  : (await isUp(API_URL))
    ? API_URL
    : null;
const viaProxy = baseUrl === PROXY_URL;

let db: Db;
let closeDb: () => Promise<void> = async () => {};

beforeAll(() => {
  const handle = createDb(TEST_DATABASE_URL);
  db = handle.db;
  closeDb = () => handle.sql.end();
});

afterAll(async () => {
  await closeDb();
});

/** Insert a finished run with a fixed set of steps; returns ids for cleanup. */
async function seedFinishedRun(): Promise<{ runId: string; conversationId: string }> {
  const conversationId = newId("conv");
  const runId = newId("run");
  const now = new Date();

  await db
    .insert(conversations)
    .values({ id: conversationId, customerId: "cus_001", createdAt: now });
  await db.insert(agentRuns).values({
    id: runId,
    conversationId,
    status: "completed",
    model: "claude-sonnet-4-6",
    inputTokens: 2350,
    outputTokens: 100,
    costUsd: "0.010000",
    durationMs: 42,
    startedAt: now,
    finishedAt: now,
  });
  // A representative trace: an LLM call, a tool call, a final LLM call. Replay
  // must expand this to started/finished pairs bracketed by run_started/finished.
  await db.insert(agentSteps).values([
    {
      runId,
      seq: 1,
      type: "llm_call",
      name: "claude-sonnet-4-6",
      attempt: 1,
      inputTokens: 2350,
      outputTokens: 100,
      durationMs: 10,
      startedAt: now,
    },
    {
      runId,
      seq: 2,
      type: "tool_call",
      name: "process_refund",
      attempt: 1,
      durationMs: 5,
      startedAt: now,
    },
    {
      runId,
      seq: 3,
      type: "llm_call",
      name: "claude-sonnet-4-6",
      attempt: 1,
      inputTokens: 2350,
      outputTokens: 100,
      durationMs: 8,
      startedAt: now,
    },
  ]);

  return { runId, conversationId };
}

async function cleanupRun(runId: string, conversationId: string): Promise<void> {
  await db.delete(agentSteps).where(eq(agentSteps.runId, runId));
  await db.delete(agentRuns).where(eq(agentRuns.id, runId));
  await db.delete(conversations).where(eq(conversations.id, conversationId));
}

/**
 * Open the chat.runEvents SSE stream for `runId` over real HTTP and collect the
 * parsed RunEvents (the superjson-decoded `data:` frames). tRPC v11 SSE frames
 * look like:
 *
 *   event: connected\n data: {}\n\n           ← stream opened (ignored)
 *   data: {"json":{...RunEvent...}}\n\n         ← one tracked event
 *   event: return\n data: \n\n                 ← stream closed by the server
 *
 * We read the body stream, split on blank lines, and superjson-decode each data
 * payload that carries a `json` field. Returns once the server closes the stream
 * (`event: return`) — which it does immediately for a finished/replayed run.
 */
async function collectSseEvents(
  base: string,
  runId: string,
): Promise<{ events: RunEvent[]; contentType: string | null; accelBuffering: string | null }> {
  const input = encodeURIComponent(JSON.stringify({ json: { runId } }));
  const res = await fetch(`${base}/trpc/chat.runEvents?input=${input}`, {
    headers: { accept: "text/event-stream" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`SSE request failed: HTTP ${res.status}`);
  }
  const contentType = res.headers.get("content-type");
  const accelBuffering = res.headers.get("x-accel-buffering");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: RunEvent[] = [];
  let closed = false;

  outer: for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);

      let eventName: string | undefined;
      const dataLines: string[] = [];
      for (const rawLine of frame.split("\n")) {
        if (rawLine.startsWith("event:")) eventName = rawLine.slice(6).trim();
        else if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice(5).trim());
      }
      const data = dataLines.join("\n");

      if (eventName === "return") {
        closed = true;
        break outer;
      }
      if (data === "" || data === "{}") continue; // 'connected' handshake / empty

      const parsed = JSON.parse(data) as { json?: unknown };
      if (parsed.json !== undefined) {
        events.push(superjson.deserialize(parsed as never) as RunEvent);
      }
    }
  }
  await reader.cancel().catch(() => {});
  expect(closed, "server should close the stream with event: return").toBe(true);

  return { events, contentType, accelBuffering };
}

describe.skipIf(baseUrl === null)("SSE e2e (live server)", () => {
  it("streams a finished run's replayed events in order over real HTTP SSE", async () => {
    const { runId, conversationId } = await seedFinishedRun();
    try {
      const { events, contentType, accelBuffering } = await collectSseEvents(
        baseUrl!,
        runId,
      );

      // Transport: a real text/event-stream, marked unbuffered so the Vite proxy
      // (and any reverse proxy) passes chunks straight through — the exact
      // requirement that live chips appear DURING the run, not after it.
      expect(contentType).toContain("text/event-stream");
      expect(accelBuffering).toBe("no");

      // The replayed lifecycle, in order, decoded off the wire. Identical to what
      // a live subscriber sees (chat.test.ts asserts live↔replay parity).
      expect(events.map((event) => event.type)).toEqual([
        "run_started",
        "llm_call_started",
        "llm_call_finished",
        "tool_call_started",
        "tool_call_finished",
        "llm_call_started",
        "llm_call_finished",
        "run_finished",
      ]);

      // Brackets + identity survive superjson over the wire.
      expect(events[0]).toEqual({ type: "run_started", runId, seq: 0 });
      const last = events.at(-1)!;
      expect(last).toMatchObject({ type: "run_finished", status: "completed", seq: 3 });
      expect(events.every((event) => event.runId === runId)).toBe(true);

      // seq is non-decreasing end to end → de-dupable against a live tail.
      const seqs = events.map((event) => event.seq);
      for (let i = 1; i < seqs.length; i += 1) {
        expect(seqs[i]!).toBeGreaterThanOrEqual(seqs[i - 1]!);
      }

      // The tool step surfaces with its name + attempt; the finished llm step
      // carries the persisted tokens — status-chip granularity, faithfully.
      const toolStarted = events.find((event) => event.type === "tool_call_started");
      expect(toolStarted).toMatchObject({ name: "process_refund", attempt: 1 });
      const llmFinished = events.find((event) => event.type === "llm_call_finished");
      expect(llmFinished).toMatchObject({
        name: "claude-sonnet-4-6",
        attempt: 1,
        inputTokens: 2350,
        outputTokens: 100,
      });

      console.log(
        `[sse-e2e] OK via ${viaProxy ? "Vite proxy :5173" : "API :4011"} — ${events.length} events in order`,
      );
    } finally {
      await cleanupRun(runId, conversationId);
    }
  });

  it("opens then cleanly closes the stream for an unknown run (empty replay)", async () => {
    const { events, contentType } = await collectSseEvents(
      baseUrl!,
      "run_e2e_unknown_does_not_exist",
    );
    expect(contentType).toContain("text/event-stream");
    expect(events).toEqual([]);
  });
});
