// ---------------------------------------------------------------------------
// Admin observability + human-in-the-loop surface (/admin).
//
// Five panels, all read over the transport-thin `admin` router:
//   - StatsBar       aggregate run/cost/duration/escalation counts
//   - ChaosToggle    live fault_injection flag (first attempt fails, then retry)
//   - RunsList       every agent run; click one to load its trace
//   - TraceViewer    the selected run's persisted agent_steps, VERBATIM, in
//                    strict seq order (type badges, retry/error highlighting,
//                    collapsible input/output JSON)
//   - EscalationQueue refunds awaiting human review, with exactly-once Approve
//                    and note-required Reject
//
// Layering: this file imports SERVER TYPES ONLY (RouterOutputs from
// @loopp/server) and formatCents from @loopp/shared — it never reaches into the
// agent package, so the web bundle stays on the server-types-only side of the
// boundary. Every user-influenced string (customer/product names, refund
// reasons, raw trace input/output JSON) renders as escaped JSX text or via
// <pre>{JSON.stringify(value, null, 2)}</pre>. No raw-HTML injection sink is
// used anywhere — the closed capability surface stays closed in the admin view.
//
// Money is integer cents formatted with formatCents; costUsd / totalCostUsd
// cross the wire as numeric STRINGS (numeric(12,6)) and are formatted directly,
// never run through float math.
// ---------------------------------------------------------------------------

import type { RouterOutputs } from "@loopp/server";
import { formatCents } from "@loopp/shared";
import { useState } from "react";
import { trpc } from "../trpc";

// Server-derived view models — these can never drift from the router's actual
// responses (incl. superjson Date hydration).
type AdminStats = RouterOutputs["admin"]["stats"];
type RunSummary = RouterOutputs["admin"]["runs"][number];
type RunTrace = RouterOutputs["admin"]["trace"];
type TraceStep = RunTrace["steps"][number];
type Escalation = RouterOutputs["admin"]["escalations"][number];

export default function AdminPage() {
  // The run whose trace is shown on the right. null until a row is clicked.
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">
          Admin dashboard
        </h1>
        <p className="text-sm text-slate-500">
          Run traces, the escalation queue, and the fault-injection control.
        </p>
      </div>

      <StatsBar />
      <ChaosToggle />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RunsList
          selectedRunId={selectedRunId}
          onSelect={(runId) => setSelectedRunId(runId)}
        />
        <TraceViewer runId={selectedRunId} />
      </div>

      <EscalationQueue />
    </div>
  );
}

// --- Stats bar ---------------------------------------------------------------

function StatsBar() {
  const stats = trpc.admin.stats.useQuery();

  if (stats.isError) {
    return <ApiUnreachable detail={stats.error.message} subject="stats" />;
  }
  if (!stats.data) {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 animate-pulse rounded-lg border border-slate-200 bg-white"
          />
        ))}
      </div>
    );
  }

  const data: AdminStats = stats.data;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <StatCard label="Agent runs" value={String(data.totalRuns)} />
      {/* totalCostUsd is a numeric STRING — format the dollar string directly,
          never Number()*100 float math. */}
      <StatCard label="Total cost" value={formatUsdString(data.totalCostUsd)} />
      <StatCard label="Avg duration" value={formatDuration(data.avgDurationMs)} />
      <StatCard
        label="Open escalations"
        value={String(data.openEscalations)}
        emphasis={data.openEscalations > 0}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold ${
          emphasis ? "text-amber-600" : "text-slate-900"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

// --- Chaos (fault-injection) toggle ------------------------------------------

function ChaosToggle() {
  const utils = trpc.useUtils();
  const state = trpc.admin.faultInjection.get.useQuery();
  const setState = trpc.admin.faultInjection.set.useMutation({
    onSuccess: () => {
      // Refetch the flag (and runs, whose new traces will show retries).
      void utils.admin.faultInjection.get.invalidate();
    },
  });

  const enabled = state.data ?? false;
  const pending = setState.isPending || state.isLoading;

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-slate-900">
            Fault injection (chaos)
          </p>
          <p className="text-xs text-slate-500">
            When ON, the first payment-gateway attempt fails and the agent (and
            admin approve) retry once with the same idempotency key.
          </p>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={() => setState.mutate({ enabled: !enabled })}
          aria-pressed={enabled}
          className={`inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-medium transition disabled:opacity-60 ${
            enabled
              ? "border-amber-300 bg-amber-100 text-amber-800 hover:bg-amber-200"
              : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
          }`}
        >
          <span
            className={`h-2 w-2 rounded-full ${
              enabled ? "bg-amber-500" : "bg-slate-400"
            }`}
          />
          {state.isError
            ? "Unavailable"
            : pending
              ? "Saving…"
              : enabled
                ? "ON"
                : "OFF"}
        </button>
      </div>
      {state.isError && (
        <p className="mt-2 text-sm text-red-600">
          Could not read the chaos flag — is the server running? (
          {state.error.message})
        </p>
      )}
      {setState.isError && (
        <p className="mt-2 text-sm text-red-600">
          Could not change the chaos flag: {setState.error.message}
        </p>
      )}
    </div>
  );
}

// --- Runs list ---------------------------------------------------------------

function RunsList({
  selectedRunId,
  onSelect,
}: {
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
}) {
  const runs = trpc.admin.runs.useQuery();

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Agent runs
      </h2>
      {runs.isError ? (
        <ApiUnreachable detail={runs.error.message} subject="runs" />
      ) : !runs.data ? (
        <p className="text-sm text-slate-500">Loading runs…</p>
      ) : runs.data.length === 0 ? (
        <EmptyState>No agent runs yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {runs.data.map((run) => (
            <RunRow
              key={run.runId}
              run={run}
              selected={run.runId === selectedRunId}
              onSelect={() => onSelect(run.runId)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RunRow({
  run,
  selected,
  onSelect,
}: {
  run: RunSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`w-full rounded-lg border px-3 py-2.5 text-left transition ${
          selected
            ? "border-slate-900 bg-slate-50 ring-1 ring-slate-900"
            : "border-slate-200 bg-white hover:bg-slate-50"
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          {/* Customer name is untrusted — escaped text. */}
          <span className="truncate text-sm font-medium text-slate-900">
            {run.customerName}
          </span>
          <RunStatusBadge status={run.status} />
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Chip>{formatDuration(run.durationMs)}</Chip>
          <Chip>
            {run.inputTokens.toLocaleString("en-US")} in /{" "}
            {run.outputTokens.toLocaleString("en-US")} out tok
          </Chip>
          {/* costUsd is a numeric string; format directly, no float math. */}
          <Chip>{formatUsdString(run.costUsd)}</Chip>
        </div>
        <p className="mt-1 font-mono text-[11px] text-slate-400">
          {run.runId} · {formatDateTime(run.startedAt)}
        </p>
      </button>
    </li>
  );
}

// --- Trace viewer ------------------------------------------------------------

function TraceViewer({ runId }: { runId: string | null }) {
  // skipToken-free: the query is simply disabled until a run is selected, so we
  // never fire admin.trace with a null id.
  const trace = trpc.admin.trace.useQuery(
    { runId: runId ?? "" },
    { enabled: runId !== null },
  );

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Run trace
      </h2>
      {runId === null ? (
        <EmptyState>Select a run to inspect its trace.</EmptyState>
      ) : trace.isError ? (
        <ApiUnreachable detail={trace.error.message} subject="this trace" />
      ) : !trace.data ? (
        <p className="text-sm text-slate-500">Loading trace…</p>
      ) : (
        <TraceBody trace={trace.data} />
      )}
    </section>
  );
}

function TraceBody({ trace }: { trace: RunTrace }) {
  const { run, steps } = trace;
  return (
    <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-4">
      {/* Run-totals header — rendered from the persisted run row, not recomputed. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-3">
        <RunStatusBadge status={run.status} />
        <Chip>{run.model}</Chip>
        <Chip>
          {run.inputTokens.toLocaleString("en-US")} in /{" "}
          {run.outputTokens.toLocaleString("en-US")} out tok
        </Chip>
        <Chip>{formatUsdString(run.costUsd)}</Chip>
        <Chip>{formatDuration(run.durationMs)}</Chip>
      </div>

      {steps.length === 0 ? (
        <p className="text-sm text-slate-500">
          This run recorded no steps.
        </p>
      ) : (
        <ol className="space-y-2">
          {/* VERBATIM, in the seq order the server returned (seq ASC). */}
          {steps.map((step) => (
            <StepRow key={step.seq} step={step} />
          ))}
        </ol>
      )}
    </div>
  );
}

function StepRow({ step }: { step: TraceStep }) {
  const [open, setOpen] = useState(false);
  const isError = step.error !== null;
  const isGuardrail = step.type === "guardrail";

  // Guardrail steps are VISUALLY DISTINCT: a violet tint + left accent border,
  // separate from llm_call / tool_call. Error rows are tinted red and win over
  // the guardrail styling so a failure is never visually swallowed.
  const containerTone = isError
    ? "border-red-300 bg-red-50"
    : isGuardrail
      ? "border-violet-300 border-l-4 border-l-violet-500 bg-violet-50"
      : "border-slate-200 bg-white";

  return (
    <li className={`rounded-md border ${containerTone}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span className="w-6 shrink-0 font-mono text-xs text-slate-400">
          {step.seq}
        </span>
        <StepTypeBadge type={step.type} />
        {/* Step name is server-controlled (tool/guardrail name) but rendered as
            escaped text regardless. */}
        <span className="flex-1 truncate text-sm font-medium text-slate-800">
          {step.name}
        </span>
        {step.attempt > 1 && (
          <span className="rounded-full bg-orange-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-orange-700">
            retry · attempt {step.attempt}
          </span>
        )}
        {isError && (
          <span className="rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-red-700">
            error
          </span>
        )}
        <StepMeta step={step} />
        <span className="ml-1 text-slate-400">{open ? "▾" : "▸"}</span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-slate-200/70 px-3 py-2">
          {isError && (
            <JsonBlock label="Error" tone="error" value={step.error} />
          )}
          <JsonBlock label="Input" value={step.input} />
          <JsonBlock label="Output" value={step.output} />
        </div>
      )}
    </li>
  );
}

function StepMeta({ step }: { step: TraceStep }) {
  const parts: string[] = [];
  if (step.inputTokens !== null || step.outputTokens !== null) {
    parts.push(`${step.inputTokens ?? 0}/${step.outputTokens ?? 0} tok`);
  }
  if (step.durationMs !== null) {
    parts.push(formatDuration(step.durationMs));
  }
  if (parts.length === 0) return null;
  return (
    <span className="hidden whitespace-nowrap text-[11px] text-slate-400 sm:inline">
      {parts.join(" · ")}
    </span>
  );
}

/**
 * Pretty-printed JSON, always via <pre>{JSON.stringify(...)}</pre> and never a
 * raw-HTML sink. Trace input/output can carry user-influenced and even
 * prompt-injection-payload strings, so it must render as inert text.
 */
function JsonBlock({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: unknown;
  tone?: "default" | "error";
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
        {label}
      </p>
      <pre
        className={`max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border p-2 font-mono text-xs ${
          tone === "error"
            ? "border-red-200 bg-red-50 text-red-800"
            : "border-slate-200 bg-slate-50 text-slate-700"
        }`}
      >
        {value === null || value === undefined
          ? "—"
          : typeof value === "string"
            ? value
            : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function StepTypeBadge({ type }: { type: TraceStep["type"] }) {
  // Each type is visually distinct: llm_call (sky), tool_call (emerald),
  // guardrail (violet). Guardrail also gets the row-level accent above.
  const tone =
    type === "llm_call"
      ? "bg-sky-100 text-sky-700"
      : type === "tool_call"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-violet-100 text-violet-700"; // guardrail
  return (
    <span
      className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold uppercase ${tone}`}
    >
      {type}
    </span>
  );
}

// --- Escalation queue --------------------------------------------------------

function EscalationQueue() {
  const utils = trpc.useUtils();
  const escalations = trpc.admin.escalations.useQuery();

  // After a resolve (approve/reject) succeeds, refetch the queue AND the stats
  // (open-escalation count drops). Runs are unaffected (no new run).
  const refetchAfterResolve = () => {
    void utils.admin.escalations.invalidate();
    void utils.admin.stats.invalidate();
  };

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Escalation queue
      </h2>
      {escalations.isError ? (
        <ApiUnreachable detail={escalations.error.message} subject="escalations" />
      ) : !escalations.data ? (
        <p className="text-sm text-slate-500">Loading escalations…</p>
      ) : escalations.data.length === 0 ? (
        <EmptyState>No open escalations.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {escalations.data.map((escalation) => (
            <EscalationCard
              key={escalation.refundId}
              escalation={escalation}
              onResolved={refetchAfterResolve}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function EscalationCard({
  escalation,
  onResolved,
}: {
  escalation: Escalation;
  onResolved: () => void;
}) {
  const [showReject, setShowReject] = useState(false);
  const [note, setNote] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);

  const approve = trpc.admin.approveRefund.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: onResolved,
    onError: (error) => setActionError(error.message),
  });
  const reject = trpc.admin.rejectRefund.useMutation({
    onMutate: () => setActionError(null),
    onSuccess: () => {
      setShowReject(false);
      setNote("");
      onResolved();
    },
    onError: (error) => setActionError(error.message),
  });

  const pending = approve.isPending || reject.isPending;
  const trimmedNote = note.trim();

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-semibold text-slate-900">
            {/* Customer name is untrusted — escaped text. */}
            {escalation.customerName}
          </p>
          <p className="font-mono text-[11px] text-slate-400">
            {escalation.refundId} · order {escalation.orderId}
          </p>
          <p className="text-xs text-slate-500">
            Items: {escalation.itemIds.join(", ")}
          </p>
          {/* Refund reason is untrusted free text — escaped. */}
          <p className="text-sm text-slate-600">
            <span className="text-slate-400">Reason: </span>
            {escalation.reason}
          </p>
          <p className="text-[11px] text-slate-400">
            Escalated {formatDateTime(escalation.createdAt)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold text-slate-900">
            {/* Integer cents → formatCents, never client float math. */}
            {formatCents(escalation.amountCents)}
          </p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => approve.mutate({ refundId: escalation.refundId })}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
        >
          {approve.isPending ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setActionError(null);
            setShowReject((v) => !v);
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
        >
          {showReject ? "Cancel reject" : "Reject"}
        </button>
      </div>

      {showReject && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (trimmedNote.length === 0) return;
            reject.mutate({
              refundId: escalation.refundId,
              adminNote: trimmedNote,
            });
          }}
        >
          <label className="block text-xs font-medium text-slate-600">
            Reason for rejection (required)
          </label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="Why is this refund being rejected?"
            className="w-full resize-none rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending || trimmedNote.length === 0}
            className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:opacity-50"
          >
            {reject.isPending ? "Rejecting…" : "Confirm rejection"}
          </button>
        </form>
      )}

      {actionError && (
        // Friendly inline message — never a raw stack trace.
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          Could not resolve this escalation: {actionError}
        </p>
      )}
    </li>
  );
}

// --- Shared bits -------------------------------------------------------------

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
      {children}
    </span>
  );
}

function RunStatusBadge({ status }: { status: RunSummary["status"] }) {
  const tone =
    status === "completed"
      ? "bg-emerald-100 text-emerald-700"
      : status === "running"
        ? "bg-sky-100 text-sky-700"
        : "bg-red-100 text-red-700"; // failed
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${tone}`}
    >
      {status}
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

function ApiUnreachable({
  detail,
  subject,
}: {
  detail: string;
  subject: string;
}) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      Could not load {subject} — is the server running? ({detail})
    </p>
  );
}

// --- Formatting helpers ------------------------------------------------------

/**
 * Format a numeric(12,6) dollar STRING (e.g. "0.001234") as USD without any
 * float math on cents. We parse to a Number only for Intl formatting of a
 * dollar value — never multiply by 100 / treat it as cents — so no integer-cent
 * invariant is touched. Non-numeric input falls back to the raw string.
 */
function formatUsdString(value: string): string {
  const dollars = Number(value);
  if (!Number.isFinite(dollars)) return `$${value}`;
  return dollars.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    // costs are sub-cent (numeric(12,6)); show enough precision to be useful.
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatDateTime(value: Date): string {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
