import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import superjson from "superjson";
import App from "./App";
import "./index.css";
import { trpc } from "./trpc";

function Root() {
  const [queryClient] = useState(() => new QueryClient());
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        splitLink({
          // SSE subscriptions (chat.runEvents) flow over httpSubscriptionLink;
          // queries/mutations stay on the batch link. The transformer lives on
          // each link in tRPC v11 (not on the client root).
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({ url: "/trpc", transformer: superjson }),
          false: httpBatchLink({ url: "/trpc", transformer: superjson }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
