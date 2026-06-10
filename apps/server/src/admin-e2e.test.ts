// ---------------------------------------------------------------------------
// Admin end-to-end test — drives the admin router over the REAL HTTP transport
// (the running Express tRPC server, and the Vite /trpc proxy in front of it when
// up), NOT through createCaller. This is the wire-level companion to
// admin.test.ts: those assertions go through appRouter.createCaller (in-process,
// scripted deps); here the request crosses the actual network the browser uses,
// so it proves the exactly-once approve, the note-required reject, the guard
// codes, and the live chaos round-trip survive the express adapter + superjson
// transport — with real refunds rows (read back through @loopp/db) as evidence.
//
// No ANTHROPIC_API_KEY and no LLM: approve / reject / chaos exercise ONLY the
// mock gateway (server-side), and the fixtures are escalated refunds inserted
// directly via a DB handle. The HTTP server already owns its own shared
// MockPaymentGateway (one per process), which is exactly what makes a double
// approve over the wire collapse to a single execution — the durable guard is
// the status-conditioned UPDATE, asserted here against the persisted row.
//
// Transport shape (tRPC v11 + superjson over httpBatchLink-equivalent fetch):
//   query    GET  /trpc/<proc>?input=<urlencoded {"json": <input>}>
//   mutation POST /trpc/<proc>  body {"json": <input>}
//   success  -> { result: { data: { json: <output> } } }
//   error    -> { error: { json: { ..., data: { code, httpStatus } } } }
// Using fetch with this framing is transport-equivalent to createTRPCClient +
// httpBatchLink + superjson (the same choice sse-e2e.test.ts makes) and avoids
// adding @trpc/client to the server package's dependency set.
//
// describe.skipIf: if the dev server isn't reachable (CI with no servers up),
// the whole suite SKIPS — a live-server e2e must never fail CI. It never needs a
// key, so it does not gate on ANTHROPIC_API_KEY. Every fixture is self-cleaning.
// ---------------------------------------------------------------------------

import { appSettings, createDb, refunds, type Db } from "@loopp/db";
import { and, eq } from "drizzle-orm";
import superjson from "superjson";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://loopp:loopp@localhost:5436/loopp";

// Prefer the Vite proxy (:5173) so we assert admin calls survive proxy
// passthrough — the exact path the browser uses; fall back to the API directly
// (:4011). Overridable for other setups (mirrors sse-e2e.test.ts).
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
// gets a real boolean. Proxy if up, else API, else null → SKIP.
const baseUrl: string | null = (await isUp(PROXY_URL))
  ? PROXY_URL
  : (await isUp(API_URL))
    ? API_URL
    : null;
const viaProxy = baseUrl === PROXY_URL;

let db: Db;
let closeDb: () => Promise<void> = async () => {};

// Track inserted fixture ids so afterEach removes exactly what each test staged
// (the e2e shares the real seeded DB; it must leave no residue).
const stagedRefundIds = new Set<string>();

beforeAll(() => {
  const handle = createDb(TEST_DATABASE_URL);
  db = handle.db;
  closeDb = () => handle.sql.end();
});

afterAll(async () => {
  await closeDb();
});

afterEach(async () => {
  // Remove every refund this test staged, then reset the chaos flag. A test that
  // flips fault_injection ON (over the wire, into the SHARED app_settings the
  // running server reads) must not leak that into the next test — which asserts
  // the flag starts OFF — so this reset keeps the suite order-independent. The
  // server owns the gateway, so there is no in-memory state to clear here: the
  // next test stages a fresh refund id (a fresh idempotency key) regardless.
  for (const id of stagedRefundIds) {
    await db.delete(refunds).where(eq(refunds.id, id));
  }
  stagedRefundIds.clear();
  await db
    .update(appSettings)
    .set({ value: false })
    .where(eq(appSettings.key, "fault_injection"));
});

// --- tRPC-over-HTTP helpers (superjson framing) ------------------------------

interface TrpcError {
  code: string;
  httpStatus: number;
  message: string;
}

/** A decoded tRPC response: success data OR a structured error (never throws
 *  on a tRPC-level error — the caller asserts on `error`). */
interface TrpcOutcome<T> {
  data?: T;
  error?: TrpcError;
}

function decodeOutcome<T>(body: unknown): TrpcOutcome<T> {
  const envelope = body as {
    result?: { data?: unknown };
    error?: { json?: { message?: string; data?: { code?: string; httpStatus?: number } } };
  };
  if (envelope.error !== undefined) {
    const e = envelope.error.json ?? {};
    return {
      error: {
        code: e.data?.code ?? "UNKNOWN",
        httpStatus: e.data?.httpStatus ?? 0,
        message: e.message ?? "",
      },
    };
  }
  // result.data is the superjson-wrapped output: { json: <value>, meta? }.
  const data = superjson.deserialize(
    (envelope.result?.data ?? { json: null }) as never,
  ) as T;
  return { data };
}

/** GET a query procedure over real HTTP with a superjson-encoded input. */
async function query<T>(proc: string, input: unknown): Promise<TrpcOutcome<T>> {
  const encoded = encodeURIComponent(
    JSON.stringify(superjson.serialize(input)),
  );
  const res = await fetch(`${baseUrl}/trpc/${proc}?input=${encoded}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  return decodeOutcome<T>(await res.json());
}

/** POST a mutation procedure over real HTTP with a superjson-encoded body. */
async function mutate<T>(proc: string, input: unknown): Promise<TrpcOutcome<T>> {
  const res = await fetch(`${baseUrl}/trpc/${proc}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(superjson.serialize(input)),
    signal: AbortSignal.timeout(10_000),
  });
  return decodeOutcome<T>(await res.json());
}

// A refund row as it surfaces over the wire (dates hydrated by superjson).
interface WireRefund {
  refundId?: string;
  id?: string;
  status: string;
  decidedBy: string | null;
  adminNote: string | null;
  gatewayRef: string | null;
  amountCents: number;
  resolvedAt: Date | null;
}

// --- Fixtures -----------------------------------------------------------------

interface SeedRefundInput {
  id: string;
  orderId: string;
  customerId: string;
  itemIds: string[];
  amountCents: number;
  status: "escalated" | "processed";
  reason?: string;
}

/** Insert one refunds row directly and register it for afterEach cleanup. */
async function insertRefund(input: SeedRefundInput): Promise<string> {
  const now = new Date();
  const resolved = input.status !== "escalated";
  await db.insert(refunds).values({
    id: input.id,
    orderId: input.orderId,
    customerId: input.customerId,
    conversationId: null,
    runId: null,
    amountCents: input.amountCents,
    itemIds: input.itemIds,
    reason: input.reason ?? "e2e fixture",
    status: input.status,
    decidedBy: input.status === "escalated" ? null : "agent",
    gatewayRef: resolved ? `gw_${input.id}` : null,
    createdAt: now,
    resolvedAt: resolved ? now : null,
  });
  stagedRefundIds.add(input.id);
  return input.id;
}

async function refundRow(refundId: string): Promise<WireRefund | null> {
  const rows = await db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  return (rows[0] as WireRefund | undefined) ?? null;
}

async function approvedCount(refundId: string): Promise<number> {
  const rows = await db
    .select({ id: refunds.id })
    .from(refunds)
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "approved")));
  return rows.length;
}

// Unique-ish ids so a re-run after an interrupted suite never collides with a
// leftover row (the gateway also keys on the refund id, so a fresh id is a
// fresh idempotency key — no cross-run bleed).
const tag = `e2e_${Date.now().toString(36)}`;

// ---------------------------------------------------------------------------

describe.skipIf(baseUrl === null)("admin e2e (live HTTP server)", () => {
  it("approve over HTTP is exactly-once under a double-click: one gateway execution, one 'approved' row", async () => {
    // ord_1002 ($899) is over the $500 threshold — the agent can only escalate
    // it, so admin approve is the sole resolution path. Drive TWO sequential
    // approve POSTs over the wire (a double-click / retried request).
    const refundId = `ref_${tag}_appr`;
    await insertRefund({
      id: refundId,
      orderId: "ord_1002",
      customerId: "cus_001",
      itemIds: ["itm_1002_1"],
      amountCents: 89900,
      status: "escalated",
    });

    const first = await mutate<WireRefund>("admin.approveRefund", { refundId });
    const second = await mutate<WireRefund>("admin.approveRefund", { refundId });

    // Both HTTP calls succeed and return the SAME resolved row (idempotent).
    expect(first.error, first.error?.message).toBeUndefined();
    expect(second.error, second.error?.message).toBeUndefined();
    expect(first.data?.status).toBe("approved");
    expect(second.data?.status).toBe("approved");
    expect(second.data?.gatewayRef).toBe(first.data?.gatewayRef);

    // The DURABLE proof: exactly one 'approved' row, resolved by the admin, with
    // a gatewayRef from a real (single) execution. The conditional UPDATE — not
    // any in-memory flag — is what makes the second wire call a no-op.
    expect(await approvedCount(refundId)).toBe(1);
    const row = await refundRow(refundId);
    expect(row?.status).toBe("approved");
    expect(row?.decidedBy).toBe("admin");
    expect(row?.gatewayRef).toBe(`gw_${refundId}`);
    expect(row?.resolvedAt).not.toBeNull();
    // The admin never altered the server-computed amount, and approve stamps no
    // note. (Money is integer cents end to end.)
    expect(row?.amountCents).toBe(89900);
    expect(row?.adminNote).toBeNull();

    console.log(
      `[admin-e2e] approve exactly-once OK via ${viaProxy ? "Vite proxy :5173" : "API :4011"}`,
    );
  });

  it("reject over HTTP requires a note: empty adminNote -> BAD_REQUEST with zero writes; a valid note -> 'rejected', no gateway call", async () => {
    const refundId = `ref_${tag}_rej`;
    await insertRefund({
      id: refundId,
      orderId: "ord_1028",
      customerId: "cus_011",
      itemIds: ["itm_1028_1"],
      amountCents: 74900,
      status: "escalated",
    });

    // (1) Empty note is rejected by zod (.min(1)) at the transport boundary,
    // BEFORE any handler runs — the escalated row must be byte-identical after.
    const before = await refundRow(refundId);
    const empty = await mutate<WireRefund>("admin.rejectRefund", {
      refundId,
      adminNote: "",
    });
    expect(empty.error?.code).toBe("BAD_REQUEST");
    expect(empty.error?.httpStatus).toBe(400);
    expect(await refundRow(refundId)).toEqual(before);

    // (2) A valid note resolves it to 'rejected' with decidedBy='admin' and the
    // note persisted; no money ever moves on a rejection (no gatewayRef).
    const note = "Customer opened a chargeback; declining the duplicate refund.";
    const ok = await mutate<WireRefund>("admin.rejectRefund", {
      refundId,
      adminNote: note,
    });
    expect(ok.error, ok.error?.message).toBeUndefined();
    expect(ok.data?.status).toBe("rejected");

    const row = await refundRow(refundId);
    expect(row?.status).toBe("rejected");
    expect(row?.decidedBy).toBe("admin");
    expect(row?.adminNote).toBe(note);
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.gatewayRef).toBeNull();
  });

  it("approve/reject guards over HTTP: unknown id -> NOT_FOUND, terminal (processed) id -> CONFLICT, both leave the DB untouched", async () => {
    // Unknown id: no row exists, NOT_FOUND, nothing created.
    const unknownId = `ref_${tag}_unknown`;
    const unknownApprove = await mutate<WireRefund>("admin.approveRefund", {
      refundId: unknownId,
    });
    expect(unknownApprove.error?.code).toBe("NOT_FOUND");
    expect(unknownApprove.error?.httpStatus).toBe(404);
    expect(await refundRow(unknownId)).toBeNull();

    const unknownReject = await mutate<WireRefund>("admin.rejectRefund", {
      refundId: unknownId,
      adminNote: "n",
    });
    expect(unknownReject.error?.code).toBe("NOT_FOUND");
    expect(await refundRow(unknownId)).toBeNull();

    // Terminal (processed) id: the row exists but is not escalated -> CONFLICT,
    // and the existing row is left byte-identical by both verbs.
    const terminalId = `ref_${tag}_terminal`;
    await insertRefund({
      id: terminalId,
      orderId: "ord_1013",
      customerId: "cus_004",
      itemIds: ["itm_1013_1"],
      amountCents: 3999,
      status: "processed",
    });
    const before = await refundRow(terminalId);

    const termApprove = await mutate<WireRefund>("admin.approveRefund", {
      refundId: terminalId,
    });
    expect(termApprove.error?.code).toBe("CONFLICT");
    expect(termApprove.error?.httpStatus).toBe(409);
    expect(await refundRow(terminalId)).toEqual(before);

    const termReject = await mutate<WireRefund>("admin.rejectRefund", {
      refundId: terminalId,
      adminNote: "cannot reject a paid refund",
    });
    expect(termReject.error?.code).toBe("CONFLICT");
    expect(await refundRow(terminalId)).toEqual(before);
  });

  it("chaos toggle round-trips over HTTP, and the escalated refund shows up in admin.escalations / admin.stats", async () => {
    // The flag starts OFF (afterEach resets it for every other suite too).
    const before = await query<boolean>("admin.faultInjection.get", null);
    expect(before.error, before.error?.message).toBeUndefined();
    expect(before.data).toBe(false);

    // Flip it ON over the wire; the very next GET reflects the write (the value
    // lives in app_settings, read fresh by every gateway call).
    const setOn = await mutate<boolean>("admin.faultInjection.set", {
      enabled: true,
    });
    expect(setOn.data).toBe(true);
    const afterOn = await query<boolean>("admin.faultInjection.get", null);
    expect(afterOn.data).toBe(true);

    // Stage an escalated refund and confirm it surfaces through the read
    // surface the queue renders (escaped, integer cents), AND that the open
    // -escalation counter in stats reflects it.
    const refundId = `ref_${tag}_queue`;
    await insertRefund({
      id: refundId,
      orderId: "ord_1023",
      customerId: "cus_008",
      itemIds: ["itm_1023_1"],
      amountCents: 52500,
      status: "escalated",
      reason: "standing desk motor failed",
    });

    const escalations = await query<WireRefund[]>("admin.escalations", null);
    expect(escalations.error, escalations.error?.message).toBeUndefined();
    const mine = escalations.data?.find((row) => row.refundId === refundId);
    expect(mine).toBeDefined();
    expect(mine?.status).toBeUndefined(); // the summary shape carries no status
    expect(mine?.amountCents).toBe(52500);
    // Every row in the queue is genuinely escalated (verified against the DB).
    for (const row of escalations.data ?? []) {
      const dbRow = await refundRow(row.refundId!);
      expect(dbRow?.status).toBe("escalated");
    }

    const stats = await query<{
      totalRuns: number;
      totalCostUsd: string;
      openEscalations: number;
    }>("admin.stats", null);
    expect(stats.error, stats.error?.message).toBeUndefined();
    // costUsd-family fields cross the wire as numeric strings (no float math).
    expect(typeof stats.data?.totalCostUsd).toBe("string");
    expect(Number.isNaN(Number(stats.data?.totalCostUsd))).toBe(false);
    // openEscalations counts at least the one we just staged and equals the DB.
    const escRows = await db
      .select({ id: refunds.id })
      .from(refunds)
      .where(eq(refunds.status, "escalated"));
    expect(stats.data?.openEscalations).toBe(escRows.length);
    expect(stats.data?.openEscalations).toBeGreaterThanOrEqual(1);

    // Flip chaos back OFF over the wire (afterEach also resets, but assert the
    // round-trip closes cleanly).
    const setOff = await mutate<boolean>("admin.faultInjection.set", {
      enabled: false,
    });
    expect(setOff.data).toBe(false);
    expect((await query<boolean>("admin.faultInjection.get", null)).data).toBe(
      false,
    );
  });

  it("approve over HTTP succeeds while chaos is ON (server retries the gateway once with the same key) and stays exactly-once", async () => {
    // With fault injection ON, the server's FIRST gateway attempt per key throws
    // a retryable 503; the admin approve path retries ONCE with the same refund
    // id and succeeds — so a reviewer can approve during a chaos demo without it
    // failing. Proven end to end over the wire, with a single execution.
    const refundId = `ref_${tag}_chaos_appr`;
    await insertRefund({
      id: refundId,
      orderId: "ord_1023",
      customerId: "cus_008",
      itemIds: ["itm_1023_1"],
      amountCents: 52500,
      status: "escalated",
    });

    const setOn = await mutate<boolean>("admin.faultInjection.set", {
      enabled: true,
    });
    expect(setOn.data).toBe(true);

    const approved = await mutate<WireRefund>("admin.approveRefund", { refundId });
    expect(approved.error, approved.error?.message).toBeUndefined();
    expect(approved.data?.status).toBe("approved");
    expect(approved.data?.gatewayRef).toBe(`gw_${refundId}`);

    // Exactly one 'approved' row despite the injected first-attempt failure —
    // the retry reused the key, so money moved once.
    expect(await approvedCount(refundId)).toBe(1);
    const row = await refundRow(refundId);
    expect(row?.decidedBy).toBe("admin");
    expect(row?.resolvedAt).not.toBeNull();
    expect(row?.amountCents).toBe(52500);
  });
});
