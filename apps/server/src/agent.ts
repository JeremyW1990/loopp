// ---------------------------------------------------------------------------
// The server's singleton AgentDeps — the one place transport wiring meets the
// agent core. Attached to every tRPC context, so routers stay transport-thin
// and tests inject scripted deps by constructing a context explicitly (this
// module — and therefore the real env — is never loaded by the test suite).
//
// getLlm is lazy on purpose: the server must boot with no ANTHROPIC_API_KEY
// (zero-config empathy) and fail only at chat time with the exact fix. The
// agent loop calls getLlm() BEFORE any DB write, so keyless turns leave zero
// orphan rows. The MockPaymentGateway instance is shared process-wide so the
// admin approval path (T5) replays refunds through the same idempotency map.
//
// `now` and `sleep` are deliberately omitted: production uses the real clock
// and real exponential backoff — only tests inject recorders.
// ---------------------------------------------------------------------------

import {
  createAnthropicLlmClient,
  MissingApiKeyError,
  MockPaymentGateway,
  runEventBus,
  type AgentDeps,
  type LlmClient,
} from "@loopp/agent";
import { db } from "./db";
import { env } from "./env";

let llmClient: LlmClient | undefined;

function getLlm(): LlmClient {
  // .env.example ships `ANTHROPIC_API_KEY=`, so treat blank as absent.
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    // Default message names the exact fix:
    // "ANTHROPIC_API_KEY is not set. Add it to .env and restart the server."
    throw new MissingApiKeyError();
  }
  llmClient ??= createAnthropicLlmClient({ apiKey });
  return llmClient;
}

export const agentDeps: AgentDeps = {
  db,
  getLlm,
  model: env.ANTHROPIC_MODEL,
  gateway: new MockPaymentGateway(),
  // The process-wide live event bus: the loop emits run-lifecycle events into
  // it, and chat.runEvents forwards them to the browser. Process-local — fans
  // out within this one server process (a multi-instance deploy would need a
  // shared transport; noted as a before-prod follow-up).
  events: runEventBus,
};
