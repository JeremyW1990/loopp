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
