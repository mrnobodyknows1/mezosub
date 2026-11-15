// MezoSub background worker (Render): indexer → scheduler (planner + keeper executor) → webhooks → notifications,
// every WORKER_INTERVAL_MS, with a heartbeat for /api/health.
//   npm run worker         # loop
//   npm run worker:once    # single pass, then exit (non-zero if a step failed)

import "./load-env";
import { randomBytes } from "node:crypto";
import { contracts, isDeployed } from "@/lib/chain/config";
import { closeDb, dbKind, getDb } from "@/lib/server/db";
import { env } from "@/lib/server/env";
import { getKeeper } from "@/lib/server/keeper";
import { runWorkerPass } from "@/lib/server/worker";

const once = process.argv.includes("--once");
const workerId = `worker-${process.pid}-${randomBytes(3).toString("hex")}`;
let stopping = false;
let wake: (() => void) | null = null;

function log(msg: string, extra?: Record<string, unknown>) {
  console.log(`${new Date().toISOString()} [worker] ${msg}${extra ? " " + JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : ""}`);
}

function onSignal(sig: string) {
  if (stopping) return;
  stopping = true;
  log(`${sig} received — finishing the current pass, then exiting`);
  wake?.();
}
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));

async function main() {
  const sql = await getDb();
  const keeper = getKeeper();
  log("starting", {
    id: workerId,
    db: dbKind(),
    deployed: isDeployed,
    manager: contracts.manager,
    registry: contracts.registry,
    keeper: keeper ? keeper.address : "disabled (no KEEPER_PRIVATE_KEY): planning only",
    intervalMs: env.workerIntervalMs(),
    retryDelays: env.retryDelays(),
    demoMode: env.demoMode(),
  });
  if (!isDeployed) log("contracts not deployed (NEXT_PUBLIC_MANAGER_ADDRESS / NEXT_PUBLIC_REGISTRY_ADDRESS unset) — indexer idle");

  let failures = 0;
  while (!stopping) {
    const r = await runWorkerPass(sql, {
      keeper,
      workerId,
      log: (m, x) => log(m, x),
    }).catch((e) => {
      log("pass crashed", { error: (e as Error).message });
      return null;
    });
    if (r) {
      log("pass", {
        ms: r.ms,
        ok: r.ok,
        indexer: r.indexer,
        scheduler: r.scheduler && "outcomes" in r.scheduler ? { planned: r.scheduler.planned, claimed: r.scheduler.claimed, outcomes: r.scheduler.outcomes } : r.scheduler,
        webhooks: r.webhooks,
        notifications: r.notifications,
      });
    }
    failures = r?.ok ? 0 : failures + 1;
    if (once) {
      await closeDb();
      process.exit(r?.ok ? 0 : 1);
    }
    // Back off a little on repeated failures (RPC outage), capped at 2 minutes.
    const delay = Math.min(env.workerIntervalMs() * 2 ** Math.min(failures, 3), 120_000);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, delay);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
  await closeDb();
  log("stopped");
  process.exit(0);
}

main().catch(async (e) => {
  console.error("[worker] fatal", e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
