import type { HealthResponse } from "@/lib/api-types";
import { contracts, isDeployed } from "@/lib/chain/config";
import { getChain } from "@/lib/server/chain";
import { dbKind } from "@/lib/server/db";
import { route } from "@/lib/server/http";
import { indexerStatus } from "@/lib/server/indexer";
import { workerStatus } from "@/lib/server/worker";

let tokenCache: { at: number; symbol: string | null; decimals: number | null } | null = null;

export const GET = route(async (_req, { sql }): Promise<HealthResponse> => {
  const chain = getChain();
  const [chainId, head] = await Promise.all([chain.chainId().catch(() => null), chain.getBlockNumber().catch(() => null)]);
  if (!tokenCache || Date.now() - tokenCache.at > 300_000) {
    const info = await chain.tokenInfo(contracts.musd).catch(() => null);
    tokenCache = { at: Date.now(), symbol: info?.symbol ?? null, decimals: info?.decimals ?? null };
  }
  const idx = await indexerStatus(sql);
  const w = await workerStatus(sql);
  const lag = head !== null && idx.lastBlock !== null ? Number(head - idx.lastBlock) : null;
  return {
    ok: chainId !== null,
    chainId,
    head: head?.toString() ?? null,
    deployed: isDeployed,
    db: dbKind(),
    indexer: { lastBlock: idx.lastBlock?.toString() ?? null, lagBlocks: lag, updatedAt: idx.updatedAt ? new Date(idx.updatedAt).toISOString() : null },
    worker: { lastRunAt: w.lastRunAt?.toISOString() ?? null, healthy: w.healthy },
    musd: { address: contracts.musd.toLowerCase(), symbol: tokenCache.symbol, decimals: tokenCache.decimals },
  };
});
