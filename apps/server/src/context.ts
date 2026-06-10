import type { AgentDeps } from "@loopp/agent";
import type { Db } from "@loopp/db";
import { agentDeps } from "./agent";
import { db } from "./db";

/**
 * The single tRPC context, used by the express adapter AND by tests: suites
 * build this object explicitly ({ db: testDb, agent: scriptedDeps }) instead
 * of calling createContext, so a locally-present .env key can never change
 * test behavior.
 */
export interface Context {
  db: Db;
  agent: AgentDeps;
}

export function createContext(): Context {
  return { db, agent: agentDeps };
}
