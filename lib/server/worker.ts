// One worker pass: indexer → planner/executor → webhooks → notifications → heartbeat.
// Used by worker/run.ts (Render background worker) and POST /api/indexer/sync (cron fallback).

import { isDeployed } from "@/lib/chain/config";
import type { Sql } from "./db";
import { getChain, type ChainAdapter } from "./chain";
import { clock } from "./clock";
import { env } from "./env";
import { releaseLapsed, runScheduler, runUpcomingNotifications, type ExecutorResult } from "./billing";
import { runIndexerPass, type IndexerPassResult } from "./indexer";
import { getKeeper, type KeeperAdapter } from "./keeper";
import { deliverPendingWebhooks } from "./webhooks";

export interface WorkerPassResult {
  ok: boolean;
  indexer: IndexerPassResult | { error: string } | null;
  scheduler: ExecutorResult | { error: string } | null;
  /** Lapsed subscriptions sent to collectDuePayments for on-chain release (undefined when there is no keeper). */
  released?: { sent: number; hash: string | null } | { error: string };
  webhooks: { delivered: number; failed: number; retried: number } | { error: string } | null;
  notifications: number | { error: string } | null;
  ms: number;
}

const errOf = (e: unknown) => ({ error: e instanceof Error ? e.message.split("\n")[0] : String(e) });

export async function heartbeat(sql: Sql, keeperAddress: string | null) {
  // indexer_state row 'worker': last_block unused; last_block_hash carries the keeper address for /api/billing.
  await sql`
    INSERT INTO indexer_state (id, last_block, last_block_hash, updated_at) VALUES ('worker', 0, ${keeperAddress}, ${clock.now()})
    ON CONFLICT (id) DO UPDATE SET last_block_hash = COALESCE(EXCLUDED.last_block_hash, indexer_state.last_block_hash),
      updated_at = EXCLUDED.updated_at`;
}

export async function workerStatus(sql: Sql): Promise<{ lastRunAt: Date | null; healthy: boolean; keeperAddress: string | null }> {
  const [row] = await sql<{ updated_at: Date; last_block_hash: string | null }>`
    SELECT updated_at, last_block_hash FROM indexer_state WHERE id = 'worker'`;
  if (!row) return { lastRunAt: null, healthy: false, keeperAddress: null };
  const last = new Date(row.updated_at);
  const healthy = clock.now().getTime() - last.getTime() < Math.max(3 * env.workerIntervalMs(), 120_000);
  return { lastRunAt: last, healthy, keeperAddress: row.last_block_hash ?? null };
}

export async function runWorkerPass(
  sql: Sql,
  deps: { chain?: ChainAdapter; keeper?: KeeperAdapter | null; workerId?: string; log?: (m: string, x?: Record<string, unknown>) => void } = {},
): Promise<WorkerPassResult> {
  const started = Date.now();
  const chain = deps.chain ?? getChain();
  const keeper = deps.keeper === undefined ? getKeeper() : deps.keeper;
  const out: WorkerPassResult = { ok: true, indexer: null, scheduler: null, webhooks: null, notifications: null, ms: 0 };

  if (isDeployed || deps.chain) {
    try {
      out.indexer = await runIndexerPass(sql, chain);
    } catch (e) {
      out.ok = false;
      out.indexer = errOf(e);
    }
  }
  try {
    out.scheduler = await runScheduler({ sql, chain, keeper, workerId: deps.workerId ?? "worker", log: deps.log });
  } catch (e) {
    out.ok = false;
    out.scheduler = errOf(e);
  }
  if (keeper) {
    try {
      out.released = await releaseLapsed({ sql, chain, keeper, workerId: deps.workerId ?? "worker", log: deps.log });
    } catch (e) {
      out.ok = false;
      out.released = errOf(e);
    }
  }
  try {
    out.webhooks = await deliverPendingWebhooks(sql);
  } catch (e) {
    out.ok = false;
    out.webhooks = errOf(e);
  }
  try {
    out.notifications = await runUpcomingNotifications(sql);
  } catch (e) {
    out.ok = false;
    out.notifications = errOf(e);
  }
  await heartbeat(sql, keeper ? keeper.address.toLowerCase() : null).catch(() => undefined);
  out.ms = Date.now() - started;
  return out;
}
