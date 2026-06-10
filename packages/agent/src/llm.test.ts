// ---------------------------------------------------------------------------
// LLM wrapper unit tests — pure, no DB, NO network, no API key.
//
// Deliberately does NOT import the Anthropic SDK package: that import is
// allowed in llm.ts only (sdk-isolation test). Coverage here is the SDK-free surface
// every other module depends on — the scripted mock client the whole suite
// injects, and the normalized error types the loop branches on.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import {
  LlmCallError,
  MissingApiKeyError,
  createAnthropicLlmClient,
  createScriptedLlmClient,
  type LlmRequest,
  type LlmResponse,
} from "./llm";

function textResponse(text: string): LlmResponse {
  return {
    stopReason: "end_turn",
    content: [{ type: "text", text }],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

function request(overrides: Partial<LlmRequest> = {}): LlmRequest {
  return {
    model: "claude-sonnet-4-6",
    maxTokens: 1024,
    system: "test system prompt",
    tools: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...overrides,
  };
}

describe("createScriptedLlmClient", () => {
  it("returns scripted responses in queue order", async () => {
    const client = createScriptedLlmClient([textResponse("first"), textResponse("second")]);

    await expect(client.createMessage(request())).resolves.toEqual(textResponse("first"));
    await expect(client.createMessage(request())).resolves.toEqual(textResponse("second"));
    expect(client.remaining()).toBe(0);
  });

  it("throws scripted LlmCallError entries instead of returning them", async () => {
    const overloaded = new LlmCallError("Overloaded", { retryable: true, status: 529 });
    const client = createScriptedLlmClient([overloaded, textResponse("after retry")]);

    await expect(client.createMessage(request())).rejects.toBe(overloaded);
    await expect(client.createMessage(request())).resolves.toEqual(
      textResponse("after retry"),
    );
  });

  it("fails loudly when called past the end of the script", async () => {
    const client = createScriptedLlmClient([textResponse("only one")]);

    await client.createMessage(request());
    await expect(client.createMessage(request())).rejects.toThrow(
      /Scripted LLM client exhausted/,
    );
  });

  it("records every request, in order, for test assertions", async () => {
    const client = createScriptedLlmClient([textResponse("a"), textResponse("b")]);

    await client.createMessage(request({ system: "prompt one" }));
    await client.createMessage(request({ system: "prompt two" }));

    expect(client.requests).toHaveLength(2);
    expect(client.requests[0].system).toBe("prompt one");
    expect(client.requests[1].system).toBe("prompt two");
  });

  it("supports tool_use responses for scripting agent turns", async () => {
    const toolTurn: LlmResponse = {
      stopReason: "tool_use",
      content: [
        { type: "text", text: "Let me check that order." },
        { type: "tool_use", id: "toolu_1", name: "get_order", input: { orderId: "ord_1001" } },
      ],
      usage: { inputTokens: 100, outputTokens: 20 },
    };
    const client = createScriptedLlmClient([toolTurn]);

    const response = await client.createMessage(request());

    expect(response.stopReason).toBe("tool_use");
    expect(response.content).toContainEqual(
      expect.objectContaining({ type: "tool_use", name: "get_order" }),
    );
  });
});

describe("LlmCallError", () => {
  it("carries retryable and status for the loop's retry decision", () => {
    const error = new LlmCallError("rate limited", { retryable: true, status: 429 });

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("LlmCallError");
    expect(error.retryable).toBe(true);
    expect(error.status).toBe(429);
  });

  it("models permanent failures with retryable=false and no status", () => {
    const error = new LlmCallError("bad request", { retryable: false });

    expect(error.retryable).toBe(false);
    expect(error.status).toBeUndefined();
  });

  it("preserves the underlying cause when given one", () => {
    const cause = new Error("socket hang up");
    const error = new LlmCallError("connection failed", { retryable: true, cause });

    expect(error.cause).toBe(cause);
  });
});

describe("MissingApiKeyError", () => {
  it("defaults to an actionable message naming the exact fix", () => {
    const error = new MissingApiKeyError();

    expect(error.name).toBe("MissingApiKeyError");
    expect(error.message).toContain("ANTHROPIC_API_KEY");
    expect(error.message).toContain(".env");
  });

  it("accepts a custom message", () => {
    expect(new MissingApiKeyError("custom fix").message).toBe("custom fix");
  });
});

describe("createAnthropicLlmClient", () => {
  it("constructs without network I/O and exposes the narrow LlmClient surface", () => {
    // Construction must be side-effect free; actual calls are never made in
    // tests (the scripted client stands in for the real one).
    const client = createAnthropicLlmClient({ apiKey: "test-key-never-used" });

    expect(typeof client.createMessage).toBe("function");
  });
});
