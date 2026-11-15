import type { MerchantOverviewDTO } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { getChain } from "@/lib/server/chain";
import { addSeconds, clock } from "@/lib/server/clock";
import { dec, int } from "@/lib/server/db/rows";
import { paymentSelect, toPaymentDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";
import { indexerStatus } from "@/lib/server/indexer";
import { amountDueExpr, keeperAddressForDisplay, since } from "@/lib/server/queries";

export const GET = route(async (req, { sql }): Promise<MerchantOverviewDTO> => {
  const { merchant } = await requireMerchant(sql, req);
  const M = merchant.id;
  const now = clock.now();
  const [agg] = await sql<Record<string, unknown>>`
    SELECT
      (SELECT COALESCE(sum(amount), 0)::text FROM payments WHERE merchant_id = ${M} AND status = 'succeeded') AS paid,
      (SELECT COALESCE(sum(amount), 0)::text FROM refunds WHERE merchant_id = ${M}) AS refunded,
      (SELECT COALESCE(sum(trunc(amount * 2592000 / billing_interval)), 0)::text FROM subscriptions WHERE merchant_id = ${M} AND status = 'active') AS mrr,
      (SELECT count(*)::int FROM subscriptions WHERE merchant_id = ${M} AND status = 'active') AS active,
      (SELECT count(*)::int FROM subscriptions WHERE merchant_id = ${M} AND created_at > ${since(30)}) AS new30,
      (SELECT count(*)::int FROM subscriptions WHERE merchant_id = ${M} AND cancelled_at > ${since(30)}) AS cancelled30,
      (SELECT count(*)::int FROM payments WHERE merchant_id = ${M} AND status = 'failed' AND created_at > ${since(30)}) AS failed30`;
  const [up] = await sql<{ n: number; amount: string }>`
    SELECT count(*)::int AS n, COALESCE(sum(${amountDueExpr(sql)}), 0)::text AS amount
    FROM subscriptions s WHERE s.merchant_id = ${M} AND s.status = 'active' AND s.next_billing_at <= ${addSeconds(now, 7 * 86400)}`;
  const series = await sql<{ date: string; amount: string }>`
    SELECT to_char(d, 'YYYY-MM-DD') AS date, COALESCE(sum(pay.amount), 0)::text AS amount
    FROM generate_series((${now}::timestamptz AT TIME ZONE 'UTC')::date - 29, (${now}::timestamptz AT TIME ZONE 'UTC')::date, interval '1 day') d
    LEFT JOIN payments pay ON pay.merchant_id = ${M} AND pay.status = 'succeeded' AND (pay.paid_at AT TIME ZONE 'UTC')::date = d::date
    GROUP BY d ORDER BY d`;
  const keeper = await keeperAddressForDisplay(sql);
  const recent = await sql<Record<string, unknown>>`
    ${paymentSelect(sql)} WHERE pay.merchant_id = ${M} ORDER BY pay.created_at DESC LIMIT 10`;
  const idx = await indexerStatus(sql);
  const head = await getChain().getBlockNumber().catch(() => null);
  const [mm] = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM audit_logs
    WHERE action = 'reconcile_mismatch' AND metadata->>'merchantId' = ${M} AND created_at > ${since(7)}`;
  return {
    totalRevenue: (BigInt(dec(agg.paid)) - BigInt(dec(agg.refunded))).toString(),
    mrr: dec(agg.mrr),
    activeSubscribers: int(agg.active),
    newSubscribers30d: int(agg.new30),
    cancelled30d: int(agg.cancelled30),
    failedPayments30d: int(agg.failed30),
    upcomingCollections7d: { count: int(up.n), amount: dec(up.amount) },
    revenueSeries: series.map((r) => ({ date: String(r.date), amount: dec(r.amount) })),
    recentPayments: recent.map((r) => toPaymentDTO(r, keeper)),
    reconciliation: {
      lastIndexedBlock: idx.lastBlock?.toString() ?? null,
      chainHead: head?.toString() ?? null,
      lagBlocks: head !== null && idx.lastBlock !== null ? Number(head - idx.lastBlock) : null,
      mismatches: int(mm?.n),
    },
  };
});
