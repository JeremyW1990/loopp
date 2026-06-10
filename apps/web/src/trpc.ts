import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@loopp/server";

export const trpc = createTRPCReact<AppRouter>();
