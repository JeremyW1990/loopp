// ---------------------------------------------------------------------------
// MockPaymentGateway unit tests — pure, no DB, no network.
//
// Pin the two behaviors the refund tools build on: refund-id idempotency
// (re-processing a completed key is a no-op returning the ORIGINAL ref) and
// fault injection (first attempt per key throws a retryable 503; the same
// key then succeeds, executing exactly once).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { GatewayUnavailableError, MockPaymentGateway } from "./gateway";

const OFF = { faultInjection: false };
const ON = { faultInjection: true };

describe("MockPaymentGateway", () => {
  it("processes a new key and returns a deterministic gw_<key> ref", async () => {
    const gateway = new MockPaymentGateway();

    const result = await gateway.processRefundPayment("ref_abc123", 5999, OFF);

    expect(result).toEqual({ gatewayRef: "gw_ref_abc123" });
    expect(gateway.executionCount).toBe(1);
  });

  it("idempotency: re-processing a completed key is a no-op returning the ORIGINAL ref", async () => {
    const gateway = new MockPaymentGateway();

    const first = await gateway.processRefundPayment("ref_abc123", 5999, OFF);
    const second = await gateway.processRefundPayment("ref_abc123", 5999, OFF);
    const third = await gateway.processRefundPayment("ref_abc123", 5999, OFF);

    expect(second.gatewayRef).toBe(first.gatewayRef);
    expect(third.gatewayRef).toBe(first.gatewayRef);
    // Money moved exactly once.
    expect(gateway.executionCount).toBe(1);
  });

  it("distinct keys execute independently", async () => {
    const gateway = new MockPaymentGateway();

    const a = await gateway.processRefundPayment("ref_a", 1000, OFF);
    const b = await gateway.processRefundPayment("ref_b", 2000, OFF);

    expect(a.gatewayRef).toBe("gw_ref_a");
    expect(b.gatewayRef).toBe("gw_ref_b");
    expect(gateway.executionCount).toBe(2);
  });

  describe("fault injection", () => {
    it("first attempt per key throws a retryable 503 GatewayUnavailableError", async () => {
      const gateway = new MockPaymentGateway();

      const attempt = gateway.processRefundPayment("ref_abc123", 5999, ON);

      await expect(attempt).rejects.toBeInstanceOf(GatewayUnavailableError);
      await expect(gateway.processRefundPayment("ref_xyz", 1, ON)).rejects.toMatchObject({
        name: "GatewayUnavailableError",
        status: 503,
        retryable: true,
      });
      // A failed attempt never moves money.
      expect(gateway.executionCount).toBe(0);
    });

    it("the SAME key succeeds on retry, executing exactly once", async () => {
      const gateway = new MockPaymentGateway();

      await expect(gateway.processRefundPayment("ref_abc123", 5999, ON)).rejects.toThrow(
        GatewayUnavailableError,
      );
      const retry = await gateway.processRefundPayment("ref_abc123", 5999, ON);

      expect(retry.gatewayRef).toBe("gw_ref_abc123");
      expect(gateway.executionCount).toBe(1);
    });

    it("each key consumes its own injected fault", async () => {
      const gateway = new MockPaymentGateway();

      await expect(gateway.processRefundPayment("ref_a", 1000, ON)).rejects.toThrow();
      await gateway.processRefundPayment("ref_a", 1000, ON);
      await expect(gateway.processRefundPayment("ref_b", 2000, ON)).rejects.toThrow();
      await gateway.processRefundPayment("ref_b", 2000, ON);

      expect(gateway.executionCount).toBe(2);
    });

    it("a completed key stays a no-op even with fault injection on", async () => {
      const gateway = new MockPaymentGateway();
      const original = await gateway.processRefundPayment("ref_abc123", 5999, OFF);

      // Toggling chaos on afterwards must not fail or re-execute a key that
      // already moved money.
      const replay = await gateway.processRefundPayment("ref_abc123", 5999, ON);

      expect(replay.gatewayRef).toBe(original.gatewayRef);
      expect(gateway.executionCount).toBe(1);
    });

    it("fault injection off: first attempt succeeds immediately", async () => {
      const gateway = new MockPaymentGateway();

      const result = await gateway.processRefundPayment("ref_abc123", 5999, OFF);

      expect(result.gatewayRef).toBe("gw_ref_abc123");
      expect(gateway.executionCount).toBe(1);
    });
  });

  describe("integer-cents guard", () => {
    it.each([
      ["float", 59.99],
      ["zero", 0],
      ["negative", -100],
      ["NaN", Number.NaN],
    ])("rejects %s amounts without executing", async (_label, amount) => {
      const gateway = new MockPaymentGateway();

      await expect(gateway.processRefundPayment("ref_bad", amount, OFF)).rejects.toThrow(
        /amountCents must be a positive integer/,
      );
      expect(gateway.executionCount).toBe(0);
    });
  });
});
