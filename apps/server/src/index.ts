import { createExpressMiddleware } from "@trpc/server/adapters/express";
import cors from "cors";
import express from "express";
import { createContext } from "./context";
import { env } from "./env";
import { appRouter } from "./router";

const app = express();

app.use(cors());
app.use(
  "/trpc",
  createExpressMiddleware({ router: appRouter, createContext }),
);
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.listen(env.PORT, () => {
  console.log(`API server listening on http://localhost:${env.PORT}`);
});
