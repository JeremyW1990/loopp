import type { inferRouterOutputs } from "@trpc/server";
import { router } from "./trpc";
import { chatRouter } from "./routers/chat";
import { conversationRouter } from "./routers/conversation";
import { customersRouter } from "./routers/customers";
import { systemRouter } from "./routers/system";

export const appRouter = router({
  system: systemRouter,
  customers: customersRouter,
  conversation: conversationRouter,
  chat: chatRouter,
});

export type AppRouter = typeof appRouter;

/**
 * Inferred output types for every procedure, e.g.
 * `RouterOutputs["conversation"]["orders"]`. The web client derives its view
 * models from these so UI types can never drift from the server's actual
 * responses (incl. superjson Date hydration). Keeps the one-way layering:
 * apps/web imports SERVER TYPES only.
 */
export type RouterOutputs = inferRouterOutputs<AppRouter>;

/**
 * The live run-activity event union, re-exported as a server type so the chat
 * UI's status-chip code can name it without importing @loopp/agent directly
 * (the agent package stays out of the web dependency graph).
 */
export type { RunEvent } from "@loopp/agent";
