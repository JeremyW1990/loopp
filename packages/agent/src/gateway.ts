// ---------------------------------------------------------------------------
// Mock payment gateway — demos production payment thinking without real money.
//
// Idempotency: callers pass the refund id as the idempotency key, so a retry
// of the same refund can never move money twice — re-processing a completed
// key is a no-op that returns the ORIGINAL gatewayRef. Fault injection (the
// app_settings 'fault_injection' toggle, read fresh by the tool layer per
// call) makes the FIRST attempt per key fail with a retryable 503 so a real
// retry shows up in the demo trace; the same key then succeeds, and
// executionCount proves the money moved exactly once.
//
// State is per-process, which is fine for the mock: the durable double-payment
// guard is the refunds ledger row, not this Map.
// ---------------------------------------------------------------------------

/** 503-style transient gateway failure — safe to retry with the SAME key. */
export class GatewayUnavailableError extends Error {
  readonly status = 503;
  readonly retryable = true;

  constructor(idempotencyKey: string) {
    super(
      `Payment gateway unavailable (503). The transaction for key "${idempotencyKey}" was not executed; retry with the same idempotency key.`,
    );
    this.name = "GatewayUnavailableError";
  }
}

export interface GatewayProcessOptions {
  /** Injected per call from app_settings 'fault_injection' — never cached. */
  faultInjection: boolean;
}

export interface GatewayResult {
  /** Deterministic per key: gw_<idempotencyKey> (cf. seeded gw_seed_* refs). */
  gatewayRef: string;
}

export class MockPaymentGateway {
  /** idempotencyKey → original gatewayRef, for completed-key no-ops. */
  private readonly completedKeys = new Map<string, string>();
  /** Keys that already consumed their one injected fault. */
  private readonly failedKeys = new Set<string>();
  private successfulExecutions = 0;

  /** Number of times money actually moved (idempotent no-ops don't count). */
  get executionCount(): number {
    return this.successfulExecutions;
  }

  async processRefundPayment(
    idempotencyKey: string,
    amountCents: number,
    options: GatewayProcessOptions,
  ): Promise<GatewayResult> {
    // Money is integer cents everywhere — a float or non-positive amount here
    // is a programming error upstream, never a retryable condition.
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error(
        `MockPaymentGateway.processRefundPayment: amountCents must be a positive integer, got ${amountCents}`,
      );
    }

    // Idempotency first: a completed key never re-executes — not even under
    // fault injection — and always returns the ref of the original execution.
    const original = this.completedKeys.get(idempotencyKey);
    if (original !== undefined) {
      return { gatewayRef: original };
    }

    // Fault injection: fail the FIRST attempt per key; the retry succeeds.
    if (options.faultInjection && !this.failedKeys.has(idempotencyKey)) {
      this.failedKeys.add(idempotencyKey);
      throw new GatewayUnavailableError(idempotencyKey);
    }

    // "Move the money."
    this.successfulExecutions += 1;
    const gatewayRef = `gw_${idempotencyKey}`;
    this.completedKeys.set(idempotencyKey, gatewayRef);
    return { gatewayRef };
  }
}
