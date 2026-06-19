import { skipToken } from "@tanstack/react-query";
// RunEvent + RouterOutputs are SERVER types (re-exported from @loopp/server),
// so the agent package stays out of the web dependency graph and UI view-models
// can never drift from the server's actual responses.
import type { RouterOutputs, RunEvent } from "@loopp/server";
import { formatCents } from "@loopp/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Markdown } from "../components/Markdown";
import { trpc } from "../trpc";

// ---------------------------------------------------------------------------
// Customer-facing refund chat.
//
// Flow: pick a seeded customer → conversation.create binds identity ONCE (no
// per-message customerId ever crosses the wire) → converse with the agent.
// While a turn runs, live status chips stream over the chat.runEvents SSE
// subscription; the assistant reply itself renders from the PERSISTED message
// history (conversation.messages), never fabricated client state — so the UI
// can only ever say what actually happened. A reload re-subscribes to the last
// run's id, and the subscription replays equivalent chips from agent_steps.
//
// Every user-influenced string (messages, product names, policy markdown, chip
// labels) is rendered as escaped JSX text — raw-HTML injection is never used
// anywhere in this app.
// ---------------------------------------------------------------------------

/** Three hard-coded starters, one per headline scenario, shown only when the
 * conversation is empty. Each is phrased the way a real customer would ask. */
const SUGGESTED_PROMPTS: readonly string[] = [
  // Happy path (cus_001 ord_1001: in-window, sub-$500, nothing final sale).
  "I'd like a refund for my Ceramic Pour-Over Coffee Set — it arrived chipped.",
  // Final-sale denial (cus_005 ord_1016 / cus_006 ord_1018 are final sale).
  "Can I return the clearance sunglasses I bought? They don't fit.",
  // Escalation (cus_008 ord_1023 $525 / cus_011 ord_1028 $1,200 are over $500).
  "I want to return my standing desk for a full refund.",
];

// Persisted across navigation/reload so returning to the chat reopens the same
// customer's thread (with its history) instead of an empty one.
const ACTIVE_CUSTOMER_KEY = "loopp.activeCustomerId";

function readSavedCustomer(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CUSTOMER_KEY);
  } catch {
    return null; // storage unavailable (private mode etc.)
  }
}

export default function ChatPage() {
  // The bound conversation, or null until a customer is picked/restored. This is
  // the ONLY place identity is established; sendMessage carries just this id.
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activeCustomerId, setActiveCustomerId] = useState<string | null>(null);
  const [showPolicy, setShowPolicy] = useState(false);
  const restored = useRef(false);

  // Resume (or create) the customer's most-recent conversation — used both when
  // a customer is picked and when restoring the last selection on mount, so the
  // thread and its history survive navigating to Admin and back.
  const open = trpc.conversation.open.useMutation({
    onSuccess: ({ conversationId: id }, variables) => {
      setActiveCustomerId(variables.customerId);
      setConversationId(id);
      try {
        localStorage.setItem(ACTIVE_CUSTOMER_KEY, variables.customerId);
      } catch {
        // ignore storage failures — selection still works for this session
      }
    },
  });

  // Restore the last-used customer once on mount (the fix for "history gone
  // after visiting Admin"): silently reopen their conversation. If the stored
  // customer no longer exists (e.g. DB reseeded), forget it without a banner.
  useEffect(() => {
    if (restored.current) return;
    restored.current = true;
    const saved = readSavedCustomer();
    if (saved === null) return;
    open.mutate(
      { customerId: saved },
      {
        onError: () => {
          try {
            localStorage.removeItem(ACTIVE_CUSTOMER_KEY);
          } catch {
            // ignore
          }
          open.reset(); // restore was automatic — never surface its error
        },
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pendingCustomerId = open.isPending
    ? (open.variables?.customerId ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">
            Customer chat
          </h1>
          <p className="text-sm text-slate-500">
            Pick a customer to start a refund conversation with the agent.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowPolicy(true)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-100"
        >
          View refund policy
        </button>
      </div>

      <CustomerPicker
        activeCustomerId={activeCustomerId}
        pendingCustomerId={pendingCustomerId}
        disabled={open.isPending}
        errorMessage={open.isError ? open.error.message : null}
        onPick={(customerId) => open.mutate({ customerId })}
      />

      {conversationId === null ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-500">
          No customer selected yet. Choose one above to load their orders and
          open a chat.
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_20rem]">
          <Conversation conversationId={conversationId} />
          <OrdersSidebar conversationId={conversationId} />
        </div>
      )}

      {showPolicy && <PolicyModal onClose={() => setShowPolicy(false)} />}
    </div>
  );
}

// --- Customer picker ----------------------------------------------------------

function CustomerPicker({
  activeCustomerId,
  pendingCustomerId,
  disabled,
  errorMessage,
  onPick,
}: {
  activeCustomerId: string | null;
  pendingCustomerId: string | null;
  disabled: boolean;
  errorMessage: string | null;
  onPick: (customerId: string) => void;
}) {
  const customers = trpc.customers.list.useQuery();

  if (customers.isError) {
    return (
      <ApiUnreachable detail={customers.error.message} subject="customers" />
    );
  }
  if (!customers.data) {
    return <p className="text-sm text-slate-500">Loading customers…</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {customers.data.map((customer) => {
          const isActive = customer.id === activeCustomerId;
          const isPending = pendingCustomerId === customer.id;
          return (
            <button
              key={customer.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(customer.id)}
              className={`rounded-full border px-3 py-1.5 text-sm transition disabled:opacity-60 ${
                isActive
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-100"
              }`}
              title={customer.email}
            >
              {isPending ? "Opening…" : customer.name}
            </button>
          );
        })}
      </div>
      {errorMessage && (
        <p className="text-sm text-red-600">
          Could not open the conversation: {errorMessage}
        </p>
      )}
    </div>
  );
}

// --- Conversation (thread + chips + composer) --------------------------------

function Conversation({ conversationId }: { conversationId: string }) {
  const messages = trpc.conversation.messages.useQuery({ conversationId });

  // The run whose chips we display. Set on send (live), or derived from the
  // most recent assistant message on load (replayed from agent_steps). A run
  // is "active" (input disabled) only while we are sending or its live stream
  // has not yet reported run_finished.
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runFinished, setRunFinished] = useState(false);
  const [draft, setDraft] = useState("");
  // PRECONDITION_FAILED from the agent loop = no ANTHROPIC_API_KEY on the
  // server. Surfaced as a friendly banner; the rest of the app stays usable.
  const [missingKey, setMissingKey] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendMessage = trpc.chat.sendMessage.useMutation({
    onMutate: () => {
      setMissingKey(null);
      setSendError(null);
    },
    onSuccess: ({ runId }) => {
      // Watch this run's live chips; the disabled state lifts on run_finished.
      setRunFinished(false);
      setActiveRunId(runId);
    },
    onError: (error) => {
      if (error.data?.code === "PRECONDITION_FAILED") {
        setMissingKey(error.message);
      } else {
        setSendError(error.message);
      }
    },
  });

  // The newest message that came from a run — its id lets a reload replay the
  // last turn's chips. We only adopt it for replay when no live run is active.
  const latestRunId = useMemo(() => {
    const rows = messages.data ?? [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const runId = rows[i]?.runId;
      if (runId) return runId;
    }
    return null;
  }, [messages.data]);

  // Subscribe to whichever run is current: the live one while sending, else the
  // last persisted run (replayed). The subscription itself decides live-forward
  // vs. replay based on the run's status, so both paths render identical chips.
  const subscribedRunId = activeRunId ?? latestRunId;
  const events = useRunEvents(subscribedRunId);

  // When the active run finishes, re-fetch the thread so the persisted assistant
  // reply appears, and lift the disabled state. (Replay-only runs never set
  // activeRunId, so they don't trigger a refetch loop.)
  const onActiveFinished = () => {
    setRunFinished(true);
    void messages.refetch();
  };
  useRunFinished(events, activeRunId, onActiveFinished);

  const isRunning =
    sendMessage.isPending || (activeRunId !== null && !runFinished);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || isRunning) return;
    setDraft("");
    sendMessage.mutate({ conversationId, text: trimmed });
  };

  if (messages.isError) {
    return <ApiUnreachable detail={messages.error.message} subject="messages" />;
  }

  const thread = messages.data ?? [];
  const isEmpty = thread.length === 0;

  return (
    <div className="flex min-h-[28rem] flex-col rounded-lg border border-slate-200 bg-white">
      <MessageList messages={thread} loading={messages.isLoading} />

      {/* Live status chips for the current run (live or replayed). */}
      {events.length > 0 && (
        <div className="border-t border-slate-100 px-4 py-3">
          <StatusChips events={events} />
        </div>
      )}

      {missingKey && (
        <MissingKeyBanner
          message={missingKey}
          onDismiss={() => setMissingKey(null)}
        />
      )}
      {sendError && (
        <p className="border-t border-slate-100 bg-red-50 px-4 py-2 text-sm text-red-700">
          The agent could not complete this turn: {sendError}
        </p>
      )}

      {isEmpty && !isRunning && (
        <SuggestedPrompts onPick={(text) => submit(text)} disabled={isRunning} />
      )}

      <Composer
        draft={draft}
        onDraftChange={setDraft}
        onSubmit={() => submit(draft)}
        disabled={isRunning}
      />
    </div>
  );
}

type MessageRow = RouterOutputs["conversation"]["messages"][number];

function MessageList({
  messages,
  loading,
}: {
  messages: MessageRow[];
  loading: boolean;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Keep the latest message in view as the thread grows.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
      {loading && messages.length === 0 ? (
        <p className="text-sm text-slate-500">Loading conversation…</p>
      ) : messages.length === 0 ? (
        <p className="text-sm text-slate-500">
          No messages yet. Ask the agent about a refund, or try a suggestion
          below.
        </p>
      ) : (
        messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))
      )}
      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: MessageRow }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] break-words rounded-2xl px-4 py-2 text-sm ${
          isUser
            ? "whitespace-pre-wrap bg-slate-900 text-white"
            : "bg-slate-100 text-slate-800"
        }`}
      >
        {/* Assistant replies render as safe markdown (no raw HTML); user text
            stays plain escaped text. Both are untrusted and never use a raw-HTML
            sink. */}
        {isUser ? message.content : <Markdown>{message.content}</Markdown>}
      </div>
    </div>
  );
}

function SuggestedPrompts({
  onPick,
  disabled,
}: {
  onPick: (text: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="border-t border-slate-100 px-4 py-3">
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        Try one
      </p>
      <div className="flex flex-col gap-2">
        {SUGGESTED_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            disabled={disabled}
            onClick={() => onPick(prompt)}
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-60"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}

function Composer({
  draft,
  onDraftChange,
  onSubmit,
  disabled,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
}) {
  return (
    <form
      className="flex items-end gap-2 border-t border-slate-200 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        disabled={disabled}
        rows={2}
        placeholder={
          disabled ? "The agent is working…" : "Type your message…"
        }
        className="flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none disabled:bg-slate-50 disabled:text-slate-400"
      />
      <button
        type="submit"
        disabled={disabled || draft.trim().length === 0}
        className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {disabled ? "Working…" : "Send"}
      </button>
    </form>
  );
}

// --- Live status chips --------------------------------------------------------

function StatusChips({ events }: { events: RunEvent[] }) {
  // One chip per *_started / guardrail / run_finished, ordered as received.
  // *_finished events update the chip's tone (error → red) rather than adding a
  // new chip, so the strip reads as a tidy activity log at status granularity.
  const chips = chipsFromEvents(events);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((chip) => (
        <span
          key={chip.key}
          className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${
            chip.tone === "error"
              ? "bg-red-100 text-red-700"
              : chip.tone === "done"
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-600"
          }`}
        >
          {chip.tone === "active" && (
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-slate-400" />
          )}
          {chip.label}
        </span>
      ))}
    </div>
  );
}

type Chip = { key: string; label: string; tone: "active" | "error" | "done" };

/** Turn the ordered event stream into human-readable chips. Each *_started (and
 * guardrail / run_finished) yields a chip; the matching *_finished sets the
 * error tone if it carried one. */
function chipsFromEvents(events: RunEvent[]): Chip[] {
  const chips: Chip[] = [];
  const indexByKey = new Map<string, number>();

  for (const event of events) {
    switch (event.type) {
      case "run_started": {
        chips.push({
          key: `start:${event.seq}`,
          label: "Reviewing your request…",
          tone: "active",
        });
        break;
      }
      case "llm_call_started": {
        const key = `llm:${event.seq}`;
        indexByKey.set(key, chips.length);
        chips.push({ key, label: "Thinking…", tone: "active" });
        break;
      }
      case "llm_call_finished": {
        const idx = indexByKey.get(`llm:${event.seq}`);
        if (idx !== undefined && event.error) {
          chips[idx] = {
            key: `llm:${event.seq}`,
            label: "Thinking failed — retrying…",
            tone: "error",
          };
        }
        break;
      }
      case "tool_call_started": {
        const key = `tool:${event.seq}`;
        indexByKey.set(key, chips.length);
        chips.push({
          key,
          label: toolLabel(event.name, event.attempt),
          tone: "active",
        });
        break;
      }
      case "tool_call_finished": {
        const idx = indexByKey.get(`tool:${event.seq}`);
        if (idx !== undefined && event.error) {
          chips[idx] = {
            key: `tool:${event.seq}`,
            label: `${toolLabel(event.name, event.attempt)} failed — retrying…`,
            tone: "error",
          };
        }
        break;
      }
      case "guardrail": {
        chips.push({
          key: `guard:${event.seq}`,
          label: "Checking access…",
          tone: "active",
        });
        break;
      }
      case "run_finished": {
        chips.push({
          key: `finish:${event.seq}`,
          label: event.status === "failed" ? "Could not finish" : "Done",
          tone: event.status === "failed" ? "error" : "done",
        });
        break;
      }
    }
  }
  return chips;
}

/** Friendly verb for a tool call, with a retry hint past attempt 1. */
function toolLabel(name: string, attempt: number): string {
  const base =
    name === "get_order"
      ? "Looking up your order…"
      : name === "process_refund"
        ? "Processing your refund…"
        : name === "escalate_to_human"
          ? "Escalating to a specialist…"
          : `Calling ${name}…`;
  return attempt > 1 ? `${base.replace(/…$/, "")} (attempt ${attempt})…` : base;
}

// --- Orders sidebar -----------------------------------------------------------

function OrdersSidebar({ conversationId }: { conversationId: string }) {
  const orders = trpc.conversation.orders.useQuery({ conversationId });

  if (orders.isError) {
    return <ApiUnreachable detail={orders.error.message} subject="orders" />;
  }

  return (
    <aside className="space-y-3">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
        Orders
      </h2>
      {!orders.data ? (
        <p className="text-sm text-slate-500">Loading orders…</p>
      ) : orders.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-500">
          This customer has no orders on file.
        </p>
      ) : (
        <ul className="space-y-3">
          {orders.data.map((order) => (
            <OrderCard key={order.id} order={order} />
          ))}
        </ul>
      )}
    </aside>
  );
}

type OrderForSidebar = RouterOutputs["conversation"]["orders"][number];

function OrderCard({ order }: { order: OrderForSidebar }) {
  // The order/item rows never change when a refund is issued — refund state is
  // derived from the refunds table by conversation.orders. The delivery status
  // stays accurate; show a "Refunded" chip when every line item has been
  // refunded (per-item chips below cover partial refunds).
  const fullyRefunded =
    order.items.length > 0 &&
    order.items.every((item) => item.refundState === "refunded");
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-xs text-slate-500">{order.id}</span>
        <div className="flex items-center gap-1.5">
          {fullyRefunded && (
            <span className="rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-medium uppercase text-violet-700">
              Refunded
            </span>
          )}
          <OrderStatusBadge status={order.status} />
        </div>
      </div>
      <ul className="mt-2 space-y-1">
        {order.items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-2">
            <span className="flex-1 break-words text-slate-700">
              {/* Product names are untrusted (one seed carries a prompt-injection
                  payload) — rendered as escaped text. */}
              {item.name}
              {item.quantity > 1 && (
                <span className="text-slate-400"> × {item.quantity}</span>
              )}
              {item.isFinalSale && (
                <span className="ml-1.5 inline-block rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-700">
                  Final sale
                </span>
              )}
              {item.refundState === "refunded" && (
                <span className="ml-1.5 inline-block rounded bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-violet-700">
                  Refunded
                </span>
              )}
              {item.refundState === "pending" && (
                <span className="ml-1.5 inline-block rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-sky-700">
                  Refund pending
                </span>
              )}
            </span>
            <span className="whitespace-nowrap text-slate-600">
              {formatCents(item.unitPriceCents)}
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-2 text-xs text-slate-500">
        <span>
          {order.deliveredAt
            ? `Delivered ${formatDate(order.deliveredAt)}`
            : `Ordered ${formatDate(order.orderedAt)}`}
        </span>
        <span className="font-medium text-slate-700">
          {formatCents(order.totalCents)}
        </span>
      </div>
    </li>
  );
}

function OrderStatusBadge({ status }: { status: OrderForSidebar["status"] }) {
  const tone =
    status === "delivered"
      ? "bg-emerald-100 text-emerald-700"
      : status === "shipped"
        ? "bg-sky-100 text-sky-700"
        : status === "processing"
          ? "bg-slate-100 text-slate-600"
          : "bg-rose-100 text-rose-700"; // cancelled
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${tone}`}
    >
      {status}
    </span>
  );
}

// --- Policy modal -------------------------------------------------------------

function PolicyModal({ onClose }: { onClose: () => void }) {
  const policy = trpc.system.policy.useQuery();
  return (
    <div
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-lg font-semibold text-slate-900">Refund policy</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-2 py-1 text-sm text-slate-500 hover:bg-slate-100"
          >
            Close
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">
          {policy.isError ? (
            <ApiUnreachable detail={policy.error.message} subject="policy" />
          ) : !policy.data ? (
            <p className="text-sm text-slate-500">Loading policy…</p>
          ) : (
            // Markdown is derived server-side from the rule data; rendered as
            // escaped, preformatted text (no HTML interpretation).
            <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-slate-700">
              {policy.data.markdown}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

// --- Shared bits --------------------------------------------------------------

function MissingKeyBanner({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}) {
  return (
    <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-medium">The agent isn’t configured yet.</p>
          {/* The server's PRECONDITION_FAILED message already names the fix. */}
          <p className="mt-0.5">{message}</p>
          <p className="mt-1 text-amber-700">
            Add <code className="font-mono">ANTHROPIC_API_KEY</code> to{" "}
            <code className="font-mono">.env</code> and restart the server, then
            try again. Your orders, history, and the policy still work.
          </p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md px-2 py-1 text-amber-700 hover:bg-amber-100"
        >
          Dismiss
        </button>
      </div>
    </div>
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

function formatDate(value: Date): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// --- Subscription hooks -------------------------------------------------------

/**
 * Subscribe to a run's live activity (or replayed activity, for a finished run)
 * and accumulate the events in arrival order, de-duped by (type, seq). The
 * server emits identical seqs for live vs. replayed streams, so re-subscribing
 * after a reload reproduces the same chip sequence. Passing null unsubscribes
 * (skipToken) and resets the buffer.
 */
function useRunEvents(runId: string | null): RunEvent[] {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const seenRef = useRef<Set<string>>(new Set());

  // Reset the accumulator whenever the subscribed run changes.
  useEffect(() => {
    seenRef.current = new Set();
    setEvents([]);
  }, [runId]);

  trpc.chat.runEvents.useSubscription(runId ? { runId } : skipToken, {
    onData: (event: RunEvent) => {
      const key = `${event.type}:${event.seq}`;
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      setEvents((prev) => [...prev, event]);
    },
  });

  return events;
}

/**
 * Invoke `onFinished` exactly once when the run identified by `activeRunId`
 * emits run_finished. No-op for replay-only runs (activeRunId === null), so a
 * reload never triggers a spurious refetch.
 */
function useRunFinished(
  events: RunEvent[],
  activeRunId: string | null,
  onFinished: () => void,
) {
  const firedFor = useRef<string | null>(null);
  useEffect(() => {
    if (activeRunId === null) return;
    if (firedFor.current === activeRunId) return;
    const finished = events.some(
      (event) => event.type === "run_finished" && event.runId === activeRunId,
    );
    if (finished) {
      firedFor.current = activeRunId;
      onFinished();
    }
    // onFinished is stable enough for this guarded one-shot; deps kept minimal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, activeRunId]);
}
