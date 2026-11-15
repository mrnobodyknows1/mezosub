import type { BillingOverviewDTO } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { addSeconds, clock } from "@/lib/server/clock";
import { bool } from "@/lib/server/db/rows";
import { jobSelect, subscriptionSelect, toBillingJobDTO, toSubscriptionDTO } from "@/lib/server/dto";
import { env } from "@/lib/server/env";
import { route } from "@/lib/server/http";
import { keeperAddressForDisplay } from "@/lib/server/queries";
import { workerStatus } from "@/lib/server/worker";

export const GET = route(async (req, { sql }): Promise<BillingOverviewDTO> => {
  const { merchant } = await requireMerchant(sql, req);
  const M = merchant.id;
  const now = clock.now();
  const upcoming = await sql<Record<string, unknown>>`
    ${jobSelect(sql)} WHERE s.merchant_id = ${M} AND j.status = 'scheduled' AND s.status = 'active'
      AND j.scheduled_at <= ${addSeconds(now, 7 * 86400)}
    ORDER BY j.scheduled_at ASC LIMIT 20`;
  const due = await sql<Record<string, unknown>>`
    ${subscriptionSelect(sql)} WHERE s.merchant_id = ${M} AND s.status = 'active' AND s.next_billing_at <= ${now}
    ORDER BY s.next_billing_at ASC LIMIT 100`;
  const failing = await sql<Record<string, unknown>>`
    ${jobSelect(sql)} WHERE s.merchant_id = ${M} AND j.status IN ('retrying','failed_final')
    ORDER BY j.updated_at DESC LIMIT 50`;
  const recent = await sql<Record<string, unknown>>`
    ${jobSelect(sql)} WHERE s.merchant_id = ${M} AND j.status IN ('succeeded','skipped','cancelled','failed_final')
    ORDER BY j.updated_at DESC LIMIT 20`;
  const w = await workerStatus(sql);
  const dueDtos = due.map(toSubscriptionDTO).filter((d) => d.state === "due" || d.state === "past_due");
  return {
    upcoming: upcoming.map(toBillingJobDTO),
    due: dueDtos.filter((d) => d.state === "due"),
    failing: failing.map(toBillingJobDTO),
    recent: recent.map(toBillingJobDTO),
    keeper: {
      address: await keeperAddressForDisplay(sql),
      enabledForMerchant: bool(merchant.keeper_enabled),
      lastRunAt: w.lastRunAt?.toISOString() ?? null,
      healthy: w.healthy && Boolean(w.keeperAddress),
    },
    retryPolicy: { delaysSeconds: env.retryDelays(), demoMode: env.demoMode() },
  };
});
