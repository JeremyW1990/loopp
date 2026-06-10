// Preflight for `pnpm setup` (tsx scripts/preflight.ts). Runs BEFORE
// `docker compose up`, so it touches no database and loads no dotenv — it
// only checks the host environment and prints an actionable checklist.
//
// Policy:
//   - Docker daemon unreachable  -> HARD FAIL (exit 1). We literally cannot
//     bring Postgres up without it, so stopping early beats a confusing
//     `docker compose` error a few seconds later.
//   - A required host port already in use -> WARNING (exit 0). A re-run with
//     the stack already up is legitimate, so this must not break setup. The
//     warning names the override env var and how to free the port.
//
// Portability: we probe ports with a Node `net.connect` (works the same on
// Docker Desktop, colima, and CI) instead of lsof/netstat, which are not
// portable across platforms.

import { execFile } from "node:child_process";
import net from "node:net";

/** A host port the local stack wants, plus how to move it if it's taken. */
interface PortCheck {
  port: number;
  label: string;
  /** The env var a reviewer sets to point this service somewhere else. */
  override: string;
}

const PORT_CHECKS: readonly PortCheck[] = [
  {
    port: 5436,
    label: "Postgres (Docker Compose)",
    override: "DATABASE_URL (e.g. postgresql://loopp:loopp@localhost:5437/loopp)",
  },
  { port: 4011, label: "API server", override: "PORT" },
  { port: 5173, label: "Web dev server", override: "WEB_PORT" },
];

/** True if the Docker daemon answers `docker info` within the timeout. */
function dockerReachable(): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      "docker",
      ["info", "--format", "{{.ServerVersion}}"],
      { timeout: 10_000 },
      (error) => resolvePromise(!error),
    );
    // execFile already rejects on spawn failure (docker not installed); the
    // callback handles that via `error`. Nothing else to do with `child`.
    child.on("error", () => resolvePromise(false));
  });
}

/**
 * True if something is already listening on `localhost:<port>`. A successful
 * TCP connect means the port is occupied; ECONNREFUSED / timeout means free.
 */
function portInUse(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (inUse: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(inUse);
    };

    socket.setTimeout(1_000);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, "127.0.0.1");
  });
}

async function main() {
  console.log("Preflight: checking Docker and host ports before db:up\n");

  const dockerOk = await dockerReachable();
  if (dockerOk) {
    console.log("  [ok]   Docker daemon is reachable");
  } else {
    console.error("  [fail] Docker daemon is NOT reachable");
    console.error(
      "         Start Docker Desktop (or `colima start`) and re-run `pnpm setup`.\n" +
        "         Postgres runs in Docker Compose, so this is required.",
    );
    process.exit(1);
  }

  const inUse = await Promise.all(PORT_CHECKS.map((c) => portInUse(c.port)));
  let anyPortTaken = false;
  PORT_CHECKS.forEach((check, i) => {
    if (inUse[i]) {
      anyPortTaken = true;
      console.warn(
        `  [warn] Port ${check.port} (${check.label}) is already in use.\n` +
          `         If that is not this stack, free the port or override it via ${check.override}.`,
      );
    } else {
      console.log(`  [ok]   Port ${check.port} (${check.label}) is free`);
    }
  });

  if (anyPortTaken) {
    console.log(
      "\nOne or more ports are busy. If the Loopp stack is already running this is fine;\n" +
        "otherwise set the override env var(s) above before `pnpm dev`.",
    );
  }

  console.log("\nPreflight complete.");
  // Port warnings are non-fatal: a re-run with the stack already up must not
  // break setup. We only ever exit non-zero on the Docker hard-fail above.
}

main().catch((err) => {
  console.error("Preflight failed unexpectedly:", err);
  process.exit(1);
});
