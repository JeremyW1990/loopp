// ---------------------------------------------------------------------------
// LLM client wrapper — the ONLY module in this repository that imports
// @anthropic-ai/sdk (pinned by sdk-isolation.test.ts). Everything else — the
// agent loop, the tools, the server, every test — depends on the narrow,
// SDK-free LlmClient interface below, which is also the mock injection point:
// createScriptedLlmClient() implements the same interface, so the whole suite
// runs with zero network access and no ANTHROPIC_API_KEY.
//
// The real client is constructed with zero SDK auto-retries on purpose: the
// agent loop owns retries so that every attempt becomes its own agent_steps
// trace row. The SDK default (2 hidden auto-retries on 429/5xx) would mask
// attempts from the trace and stack on top of the loop's retry policy.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";

// --- SDK-free message shapes -------------------------------------------------

export interface LlmTextBlock {
  type: "text";
  text: string;
}

export interface LlmToolUseBlock {
  type: "tool_use";
  /** Provider-assigned id, echoed back as `toolUseId` on the result block. */
  id: string;
  name: string;
  /** Raw model-supplied arguments — zod-validated by executeTool, never trusted. */
  input: unknown;
}

export interface LlmToolResultBlock {
  type: "tool_result";
  toolUseId: string;
  /** Tool output serialized as JSON text. */
  content: string;
  isError?: boolean;
}

export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock;

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContentBlock[];
}

/**
 * Hand-written JSON Schema for a tool's input, mirroring the zod schema it is
 * paired with in tools.ts (a sync test asserts the property keys match).
 * `additionalProperties: false` is required by the type so every tool schema
 * is closed — unknown keys are rejected at the API level and by zod.
 * (A type alias, not an interface, so it gets an implicit index signature
 * and stays assignable to the SDK's InputSchema.)
 */
export type LlmToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
};

export interface LlmToolDefinition {
  name: string;
  description: string;
  inputSchema: LlmToolInputSchema;
}

export type LlmStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmRequest {
  model: string;
  maxTokens: number;
  system: string;
  tools: LlmToolDefinition[];
  messages: LlmMessage[];
}

export interface LlmResponse {
  stopReason: LlmStopReason;
  /** Text and tool_use blocks produced by the model. */
  content: LlmContentBlock[];
  usage: LlmUsage;
}

/**
 * The narrow interface the agent loop depends on. Implemented by the real
 * Anthropic wrapper below and by createScriptedLlmClient() for tests.
 */
export interface LlmClient {
  createMessage(request: LlmRequest): Promise<LlmResponse>;
}

// --- Errors ------------------------------------------------------------------

/**
 * Normalized LLM failure. `retryable` is true for transient provider errors
 * (429 rate limit, 5xx server errors incl. 529 overloaded, network failures);
 * the loop retries those with backoff and traces each attempt as its own row.
 */
export class LlmCallError extends Error {
  readonly retryable: boolean;
  readonly status: number | undefined;

  constructor(
    message: string,
    options: { retryable: boolean; status?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LlmCallError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

/**
 * Thrown by the server's getLlm() factory when ANTHROPIC_API_KEY is absent —
 * at call time, BEFORE any DB write, so keyless setups accumulate no orphan
 * rows. The server boots fine without a key; only chat turns fail, friendly.
 */
export class MissingApiKeyError extends Error {
  constructor(
    message = "ANTHROPIC_API_KEY is not set. Add it to .env and restart the server.",
  ) {
    super(message);
    this.name = "MissingApiKeyError";
  }
}

// --- Real Anthropic client ----------------------------------------------------

/**
 * Wrap the Anthropic SDK behind LlmClient. Constructing the client performs
 * no network I/O; failures surface per call as normalized LlmCallError.
 */
export function createAnthropicLlmClient(options: { apiKey: string }): LlmClient {
  const client = new Anthropic({
    apiKey: options.apiKey,
    // The loop owns retries so each attempt is traced (see module header).
    maxRetries: 0,
  });

  return {
    async createMessage(request: LlmRequest): Promise<LlmResponse> {
      let message: Anthropic.Message;
      try {
        message = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          system: request.system,
          tools: request.tools.map(toSdkTool),
          messages: request.messages.map(toSdkMessage),
        });
      } catch (error) {
        throw normalizeAnthropicError(error);
      }

      return {
        // stop_reason is null only mid-stream; non-streaming responses always
        // carry one — treat a hypothetical null as a normal end of turn.
        stopReason: message.stop_reason ?? "end_turn",
        content: message.content.flatMap(fromSdkBlock),
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
        },
      };
    },
  };
}

function toSdkTool(tool: LlmToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

function toSdkMessage(message: LlmMessage): Anthropic.MessageParam {
  return { role: message.role, content: message.content.map(toSdkBlock) };
}

function toSdkBlock(block: LlmContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        content: block.content,
        is_error: block.isError,
      };
  }
}

function fromSdkBlock(block: Anthropic.ContentBlock): LlmContentBlock[] {
  switch (block.type) {
    case "text":
      return [{ type: "text", text: block.text }];
    case "tool_use":
      return [{ type: "tool_use", id: block.id, name: block.name, input: block.input }];
    default:
      // Thinking / server-tool blocks cannot occur with our request shape
      // (no thinking config, no server tools); drop defensively rather than
      // leak SDK-specific block types through the narrow interface.
      return [];
  }
}

/**
 * Map SDK errors to LlmCallError via the SDK's typed classes (never message
 * string-matching). Retryable: 429 (RateLimitError), every 5xx incl. 529
 * overloaded (InternalServerError — this SDK folds status >= 500 into it),
 * and connection failures that never reached the API. Everything else (400
 * invalid request, 401 auth, 404, ...) is permanent.
 */
function normalizeAnthropicError(error: unknown): LlmCallError {
  if (error instanceof LlmCallError) return error;

  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === "number" ? error.status : undefined;
    const retryable =
      error instanceof Anthropic.RateLimitError ||
      error instanceof Anthropic.InternalServerError ||
      error instanceof Anthropic.APIConnectionError ||
      (status !== undefined && (status === 429 || status >= 500));
    return new LlmCallError(error.message, { retryable, status, cause: error });
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmCallError(message, { retryable: false, cause: error });
}

// --- Scripted mock client ------------------------------------------------------

/** A scripted turn: a response to return, or an LlmCallError to throw. */
export type ScriptedLlmResult = LlmResponse | LlmCallError;

export interface ScriptedLlmClient extends LlmClient {
  /** Every request seen, in order — lets tests assert what the loop sent. */
  readonly requests: LlmRequest[];
  /** Scripted entries not yet consumed (0 when the script ran to completion). */
  remaining(): number;
}

/**
 * Queue-based mock used by all tests (and T4/T6 harnesses): each
 * createMessage call consumes the next scripted entry — returning it, or
 * throwing it when the entry is an LlmCallError. Calling past the end of the
 * script is a test bug and fails loudly.
 */
export function createScriptedLlmClient(
  script: readonly ScriptedLlmResult[],
): ScriptedLlmClient {
  const queue = [...script];
  const requests: LlmRequest[] = [];

  return {
    requests,
    remaining: () => queue.length,
    async createMessage(request: LlmRequest): Promise<LlmResponse> {
      requests.push(request);
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(
          `Scripted LLM client exhausted: call #${requests.length} has no scripted entry`,
        );
      }
      if (next instanceof LlmCallError) throw next;
      return next;
    },
  };
}
