// ---------------------------------------------------------------------------
// Admin business logic — the observability + human-in-the-loop core.
//
// Everything here is PURE over Db (and, for the money-moving paths, a shared
// MockPaymentGateway). No express, no tRPC, no web imports: the admin tRPC
// router is transport-thin and delegates to these functions, so approve/reject
// and the trace/escalation/stats assembly are fully testable offline with the
// mock gateway and need no Anthropic key.
//
// The authority boundary is the spine of this module:
//   - approveEscalatedRefund is the ONLY way a >$500 escalated refund resolves
//     to 'approved'. It executes through the SAME shared gateway as the agent
//     (refund id IS the idempotency key) and writes 'approved' ONLY after a
//     successful gateway execution, behind a status-GUARDED conditional UPDATE
//     (WHERE status='escalated'). That conditional WHERE — not the gateway's
//     in-memory map — is the DURABLE exactly-once guard: it survives a process
//     restart (empty map) and closes the double-click race (a concurrent
//     second approve updates 0 rows).
//   - rejectEscalatedRefund moves no money: it writes 'rejected' behind the
//     same status guard. A rejected refund frees its items automatically
//     because loadPriorRefunds (tools.ts) already filters out status='rejected'
//     when locking items, so no extra bookkeeping is needed here.
//
// Money is integer cents everywhere; costUsd is numeric(12,6) and surfaces as a
// string (the UI formats it, never floats it). These reads never recompute or
// fabricate — getRunTrace returns persisted agent_steps verbatim in seq order.
// ---------------------------------------------------------------------------

import {
  agentRuns,
  agentSteps,
  appSettings,
  conversations,
  customers,
  orders,
  refunds,
  type Db,
} from "@loopp/db";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { GatewayUnavailableError, type MockPaymentGateway } from "./gateway";
import { readFaultInjection } from "./tools";

// --- Dependencies ------------------------------------------------------------

/**
 * The minimal slice of AgentDeps the money-moving admin paths need: the Drizzle
 * handle and the SAME shared gateway instance the agent uses (so completedKeys
 * is shared and idempotency carries across both paths in one process). AgentDeps
 * satisfies this structurally, so the router can pass ctx.agent directly.
 */
export interface AdminDeps {
  db: Db;
  gateway: MockPaymentGateway;
}

// --- Typed errors (mirror gateway.ts / loop.ts `extends Error`) --------------

/** No refunds row with the given id — the router maps this to NOT_FOUND. */
export class RefundNotFoundError extends Error {
  readonly refundId: string;

  constructor(refundId: string) {
    super(`Refund "${refundId}" not found`);
    this.name = "RefundNotFoundError";
    this.refundId = refundId;
  }
}

/**
 * The refund exists but is not in 'escalated' state, so it cannot be
 * approved/rejected (it is already resolved or was never escalated). The
 * router maps this to CONFLICT — neither approve nor reject writes a row or
 * calls the gateway in this case.
 */
export class RefundNotEscalatedError extends Error {
  readonly refundId: string;
  readonly status: string;

  constructor(refundId: string, status: string) {
    super(`Refund "${refundId}" is "${status}", not "escalated"`);
    this.name = "RefundNotEscalatedError";
    this.refundId = refundId;
    this.status = status;
  }
}

// --- Internals ---------------------------------------------------------------

/** Attempt 1 plus exactly one retry on a retryable gateway error. Mirrors
 *  tools.ts MAX_TOOL_ATTEMPTS so chaos-toggle-on does not break approve. */
const MAX_GATEWAY_ATTEMPTS = 2;

type RefundRow = typeof refunds.$inferSelect;

async function loadRefund(db: Db, refundId: string): Promise<RefundRow | null> {
  const rows = await db
    .select()
    .from(refunds)
    .where(eq(refunds.id, refundId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Move money for an escalated refund through the shared gateway, retrying
 * EXACTLY ONCE on a retryable failure with the SAME idempotency key (the refund
 * id). A non-retryable error propagates. The gateway itself is idempotent per
 * key, so this never executes twice for one refund.
 */
async function runGatewayWithRetry(
  deps: AdminDeps,
  refundId: string,
  amountCents: number,
): Promise<{ gatewayRef: string }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_GATEWAY_ATTEMPTS; attempt += 1) {
    // Fault injection is read FRESH each attempt (same source as tools.ts), so
    // the admin chaos toggle is observed live. The first attempt under chaos
    // throws GatewayUnavailableError; the retry below reuses the same key.
    const faultInjection = await readFaultInjection(deps.db);
    try {
      return await deps.gateway.processRefundPayment(refundId, amountCents, {
        faultInjection,
      });
    } catch (error) {
      lastError = error;
      if (error instanceof GatewayUnavailableError && attempt < MAX_GATEWAY_ATTEMPTS) {
        continue;
      }
      throw error;
    }
  }
  // Unreachable: the loop returns or throws on every path.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- Authority boundary: approve / reject ------------------------------------

/**
 * Approve a >$500 escalated refund: the only path that resolves an escalation
 * to 'approved'. Idempotent and exactly-once under double-click AND replay.
 *
 *   - absent             -> RefundNotFoundError
 *   - already 'approved' -> idempotent no-op, returns the existing row (the
 *                           gateway already ran; nothing re-executes)
 *   - 'processed'|'rejected' (terminal, non-escalated) -> RefundNotEscalatedError
 *   - 'escalated'        -> move money through the shared gateway (refund id =
 *                           idempotency key, single retry on a transient
 *                           failure), then ONLY on success do a status-guarded
 *                           conditional UPDATE to 'approved'. Never writes
 *                           'approved' without a successful gateway execution.
 */
export async function approveEscalatedRefund(
  deps: AdminDeps,
  refundId: string,
  now: () => Date = () => new Date(),
): Promise<RefundRow> {
  const row = await loadRefund(deps.db, refundId);
  if (row === null) throw new RefundNotFoundError(refundId);

  // Already approved: a prior approve (this process or before a restart) ran
  // the gateway and resolved the row. Re-approving must not re-execute.
  if (row.status === "approved") return row;

  // Terminal non-escalated states cannot be approved.
  if (row.status !== "escalated") {
    throw new RefundNotEscalatedError(refundId, row.status);
  }

  // Move the money first — the refund id is the idempotency key, shared with
  // the agent path, so a double-click or replay reuses the same key and the
  // gateway executes at most once.
  const { gatewayRef } = await runGatewayWithRetry(
    deps,
    refundId,
    row.amountCents,
  );

  // Durable exactly-once guard: write 'approved' ONLY while still 'escalated'.
  // A concurrent second approve (or a reject that won the race) updates 0 rows
  // and falls through to re-read the now-resolved row below.
  await deps.db
    .update(refunds)
    .set({
      status: "approved",
      decidedBy: "admin",
      gatewayRef,
      resolvedAt: now(),
    })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "escalated")));

  // Return the resolved row (whoever won the race wrote it).
  const resolved = await loadRefund(deps.db, refundId);
  if (resolved === null) throw new RefundNotFoundError(refundId);
  return resolved;
}

/**
 * Reject an escalated refund with a (caller-validated non-empty) admin note.
 * No money moves. A rejected refund frees its order/item for a future refund
 * automatically, because loadPriorRefunds excludes status='rejected'.
 *
 *   - absent             -> RefundNotFoundError
 *   - already 'rejected' -> idempotent no-op, returns the existing row
 *   - 'processed'|'approved' (terminal) -> RefundNotEscalatedError
 *   - 'escalated'        -> status-guarded UPDATE to 'rejected' (no gateway call)
 */
export async function rejectEscalatedRefund(
  deps: AdminDeps,
  refundId: string,
  adminNote: string,
  now: () => Date = () => new Date(),
): Promise<RefundRow> {
  const row = await loadRefund(deps.db, refundId);
  if (row === null) throw new RefundNotFoundError(refundId);

  if (row.status === "rejected") return row;

  if (row.status !== "escalated") {
    throw new RefundNotEscalatedError(refundId, row.status);
  }

  // No gateway call — rejection moves no money. Same status guard as approve:
  // exactly one of a concurrent approve/reject wins the row.
  await deps.db
    .update(refunds)
    .set({
      status: "rejected",
      decidedBy: "admin",
      adminNote,
      resolvedAt: now(),
    })
    .where(and(eq(refunds.id, refundId), eq(refunds.status, "escalated")));

  const resolved = await loadRefund(deps.db, refundId);
  if (resolved === null) throw new RefundNotFoundError(refundId);
  return resolved;
}

// --- Reads: runs, trace, escalations, stats ----------------------------------

export interface RunSummary {
  runId: string;
  conversationId: string;
  customerId: string;
  customerName: string;
  status: typeof agentRuns.$inferSelect.status;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** numeric(12,6) — a string; the UI formats it, never floats it. */
  costUsd: string;
  durationMs: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

/** All agent runs joined to their conversation's customer, newest first. */
export async function listRuns(db: Db): Promise<RunSummary[]> {
  const rows = await db
    .select({
      runId: agentRuns.id,
      conversationId: agentRuns.conversationId,
      customerId: conversations.customerId,
      customerName: customers.name,
      status: agentRuns.status,
      model: agentRuns.model,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      costUsd: agentRuns.costUsd,
      durationMs: agentRuns.durationMs,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .innerJoin(conversations, eq(agentRuns.conversationId, conversations.id))
    .innerJoin(customers, eq(conversations.customerId, customers.id))
    .orderBy(desc(agentRuns.startedAt));
  return rows;
}

/** One persisted step, returned VERBATIM (no recompute, no re-order). */
export interface TraceStep {
  seq: number;
  type: typeof agentSteps.$inferSelect.type;
  name: string;
  attempt: number;
  input: unknown;
  output: unknown;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  startedAt: Date;
}

export interface RunTrace {
  run: RunSummary;
  steps: TraceStep[];
}

/**
 * A run's header plus its agent_steps in strict seq ASC order, verbatim.
 * Unknown runId -> null (the router maps it to NOT_FOUND). The viewer renders
 * exactly these rows: no totals are recomputed and no steps are fabricated.
 */
export async function getRunTrace(
  db: Db,
  runId: string,
): Promise<RunTrace | null> {
  const runRows = await db
    .select({
      runId: agentRuns.id,
      conversationId: agentRuns.conversationId,
      customerId: conversations.customerId,
      customerName: customers.name,
      status: agentRuns.status,
      model: agentRuns.model,
      inputTokens: agentRuns.inputTokens,
      outputTokens: agentRuns.outputTokens,
      costUsd: agentRuns.costUsd,
      durationMs: agentRuns.durationMs,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .innerJoin(conversations, eq(agentRuns.conversationId, conversations.id))
    .innerJoin(customers, eq(conversations.customerId, customers.id))
    .where(eq(agentRuns.id, runId))
    .limit(1);

  const run = runRows[0];
  if (run === undefined) return null;

  const steps = await db
    .select({
      seq: agentSteps.seq,
      type: agentSteps.type,
      name: agentSteps.name,
      attempt: agentSteps.attempt,
      input: agentSteps.input,
      output: agentSteps.output,
      error: agentSteps.error,
      inputTokens: agentSteps.inputTokens,
      outputTokens: agentSteps.outputTokens,
      durationMs: agentSteps.durationMs,
      startedAt: agentSteps.startedAt,
    })
    .from(agentSteps)
    .where(eq(agentSteps.runId, runId))
    .orderBy(asc(agentSteps.seq));

  return { run, steps };
}

export interface EscalationSummary {
  refundId: string;
  customerId: string;
  customerName: string;
  orderId: string;
  itemIds: string[];
  /** Integer cents. */
  amountCents: number;
  reason: string;
  createdAt: Date;
}

/** Exactly the refunds awaiting human review (status='escalated'), newest first. */
export async function listEscalations(db: Db): Promise<EscalationSummary[]> {
  const rows = await db
    .select({
      refundId: refunds.id,
      customerId: refunds.customerId,
      customerName: customers.name,
      orderId: refunds.orderId,
      itemIds: refunds.itemIds,
      amountCents: refunds.amountCents,
      reason: refunds.reason,
      createdAt: refunds.createdAt,
    })
    .from(refunds)
    .innerJoin(customers, eq(refunds.customerId, customers.id))
    .where(eq(refunds.status, "escalated"))
    .orderBy(desc(refunds.createdAt));
  return rows;
}

export interface AdminStats {
  totalRuns: number;
  /** sum(agent_runs.cost_usd) — a numeric string; the UI formats it. */
  totalCostUsd: string;
  /** avg(agent_runs.duration_ms), null when there are no finished runs. */
  avgDurationMs: number | null;
  openEscalations: number;
}

/** Aggregate dashboard stats over agent_runs and the escalation queue. */
export async function getAdminStats(db: Db): Promise<AdminStats> {
  const runAggRows = await db
    .select({
      totalRuns: count(),
      // COALESCE so an empty table yields "0" rather than null; cast keeps the
      // numeric(12,6) sum as a string across the wire (no float math client-side).
      totalCostUsd: sql<string>`COALESCE(SUM(${agentRuns.costUsd}), 0)::text`,
      avgDurationMs: sql<
        number | null
      >`AVG(${agentRuns.durationMs})::double precision`,
    })
    .from(agentRuns);
  const runAgg = runAggRows[0];

  const escalationRows = await db
    .select({ openEscalations: count() })
    .from(refunds)
    .where(eq(refunds.status, "escalated"));

  return {
    totalRuns: runAgg?.totalRuns ?? 0,
    totalCostUsd: runAgg?.totalCostUsd ?? "0",
    avgDurationMs: runAgg?.avgDurationMs ?? null,
    openEscalations: escalationRows[0]?.openEscalations ?? 0,
  };
}

// readFaultInjection lives in tools.ts (one fresh-read implementation) and is
// already re-exported through the package barrel; the router imports it from
// @loopp/agent. setFaultInjection is the write half.

// --- Fault-injection toggle --------------------------------------------------

/**
 * Upsert the app_settings 'fault_injection' flag. The matching READ is the
 * exported readFaultInjection (from tools.ts), which every gateway call reads
 * FRESH — so flipping this is observed live by the next process_refund.
 */
export async function setFaultInjection(
  db: Db,
  enabled: boolean,
): Promise<boolean> {
  await db
    .insert(appSettings)
    .values({ key: "fault_injection", value: enabled })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: enabled },
    });
  return enabled;
}
