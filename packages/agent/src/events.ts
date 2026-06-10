// ---------------------------------------------------------------------------
// In-process run event bus — the live half of agent observability.
//
// The agent loop writes one agent_steps row per llm_call / tool_call /
// guardrail and finalizes the agent_runs row; from the SAME lifecycle it also
// emits a RunEvent here, so the live stream and the persisted trace can never
// diverge. A thin tRPC subscription forwards these to the browser as status
// chips; a finished run replays equivalent events reconstructed from
// agent_steps (see event-replay.ts) so reloads and late subscribers render
// identically.
//
// The bus carries STATUS-CHIP GRANULARITY ONLY — names, attempt numbers,
// durations, token counts, and errors — never full LLM content or raw tool
// I/O. The admin trace (T5) reads complete input/output from agent_steps.
//
// This is a single-process EventEmitter: it fans out only within one server
// process, which is sufficient for the take-home demo. A multi-instance deploy
// would need a shared transport (e.g. Redis pub/sub) — noted as a before-prod
// follow-up, deliberately out of scope here.
// ---------------------------------------------------------------------------

import { EventEmitter } from "node:events";

// --- Event shape --------------------------------------------------------------

/**
 * A single live run-lifecycle event. Every variant carries `seq` — the same
 * monotonic per-run sequence the tracer assigns to agent_steps rows — so the
 * client can order events and de-duplicate across the live stream and any
 * replay tail. `run_started` and `run_finished` bracket the stream.
 */
export type RunEvent =
  | { type: "run_started"; runId: string; seq: number }
  | {
      type: "llm_call_started";
      runId: string;
      seq: number;
      name: string;
      attempt: number;
    }
  | {
      type: "llm_call_finished";
      runId: string;
      seq: number;
      name: string;
      attempt: number;
      durationMs?: number;
      inputTokens?: number;
      outputTokens?: number;
      error?: string;
    }
  | {
      type: "tool_call_started";
      runId: string;
      seq: number;
      name: string;
      attempt: number;
    }
  | {
      type: "tool_call_finished";
      runId: string;
      seq: number;
      name: string;
      attempt: number;
      durationMs?: number;
      error?: string;
    }
  | { type: "guardrail"; runId: string; seq: number; name: string }
  | {
      type: "run_finished";
      runId: string;
      seq: number;
      status: "completed" | "failed";
      error?: string;
    };

/** A terminal event closes the per-run stream (the async iterator returns). */
function isTerminal(event: RunEvent): boolean {
  return event.type === "run_finished";
}

// --- The bus ------------------------------------------------------------------

/** Listener registered for one run's events. */
export type RunEventListener = (event: RunEvent) => void;

export interface RunEventBus {
  /** Publish one event to every subscriber of `runId`. */
  emit(runId: string, event: RunEvent): void;
  /**
   * Register a listener for `runId`. Returns an unsubscribe function; call it
   * to detach (idempotent — calling twice is a no-op).
   */
  subscribe(runId: string, listener: RunEventListener): () => void;
  /**
   * Async-iterate one run's events until `run_finished` (inclusive) or the
   * optional `signal` aborts. Events emitted between `next()` calls are
   * buffered, so a consumer that subscribes before the run starts never drops
   * the head, and a slow consumer never drops the middle.
   */
  events(runId: string, signal?: AbortSignal): AsyncIterableIterator<RunEvent>;
}

/** EventEmitter channel name for a run; namespaced to avoid collisions. */
function channel(runId: string): string {
  return `run:${runId}`;
}

/**
 * Create an in-process run event bus backed by a single Node EventEmitter.
 * Pure — no DB, no network, no API key. The loop emits into it; the server
 * subscription consumes from it.
 */
export function createRunEventBus(): RunEventBus {
  const emitter = new EventEmitter();
  // Many browser tabs / late subscribers can attach to the same popular run;
  // raise the cap so legitimate fan-out never trips Node's leak warning.
  emitter.setMaxListeners(0); // 0 = unlimited

  return {
    emit(runId, event) {
      emitter.emit(channel(runId), event);
    },

    subscribe(runId, listener) {
      const name = channel(runId);
      emitter.on(name, listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        emitter.off(name, listener);
      };
    },

    events(runId, signal) {
      return runEvents(emitter, runId, signal);
    },
  };
}

/**
 * Buffered async iterator over one run's events. The emitter listener is
 * attached EAGERLY — at the moment `events()` is called, not lazily on the
 * first `next()` — so a caller that "subscribes first, reads run state second"
 * (the server's race-safe chat.runEvents) genuinely captures every event from
 * that point on, including any emitted before it pulls the first value. Events
 * arriving while the consumer is between `next()` calls are queued and yielded
 * in order. Aborting resolves any pending `next()`; the listener is always
 * detached on completion / error / `return()` (e.g. a `break` out of a
 * `for await`).
 *
 * (A bare async generator would defer its body — and thus `emitter.on` — until
 * first pull, reopening the very race the eager attach closes.)
 */
function runEvents(
  emitter: EventEmitter,
  runId: string,
  signal?: AbortSignal,
): AsyncIterableIterator<RunEvent> {
  const name = channel(runId);
  const queue: RunEvent[] = [];
  let done = false;
  // Resolver for a `next()` that is parked waiting on an empty queue.
  let wake: (() => void) | null = null;

  const push = (event: RunEvent): void => {
    queue.push(event);
    if (event.type === "run_finished") done = true;
    wake?.();
    wake = null;
  };

  const onAbort = (): void => {
    done = true;
    wake?.();
    wake = null;
  };

  // Attach synchronously, before returning the iterator, so no event is missed
  // in the window between subscribe and the first pull.
  emitter.on(name, push);
  if (signal) {
    if (signal.aborted) done = true;
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  let detached = false;
  const detach = (): void => {
    if (detached) return;
    detached = true;
    emitter.off(name, push);
    signal?.removeEventListener("abort", onAbort);
  };

  async function* drain(): AsyncIterableIterator<RunEvent> {
    try {
      for (;;) {
        // Drain everything buffered before parking — never lose ordering.
        while (queue.length > 0) {
          const event = queue.shift()!;
          yield event;
          if (isTerminal(event)) return;
        }
        if (done) return;
        // Queue empty and not done: wait for the next emit or an abort.
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    } finally {
      detach();
    }
  }

  const iterator = drain();
  // Detach the listener if the consumer never starts (or abandons) the iterator
  // without driving it to completion — return() runs drain()'s finally.
  const originalReturn = iterator.return?.bind(iterator);
  iterator.return = ((value?: unknown) => {
    detach();
    return originalReturn
      ? originalReturn(value as never)
      : Promise.resolve({ done: true as const, value: value as never });
  }) as typeof iterator.return;

  return iterator;
}

// --- Process singleton --------------------------------------------------------

/**
 * The process-wide bus the server wires into AgentDeps. The agent loop emits
 * into this instance during a live run; the chat.runEvents subscription
 * forwards from it. Tests construct their own bus (or omit it entirely — the
 * dep is optional) so they never touch this singleton.
 */
export const runEventBus: RunEventBus = createRunEventBus();
