import type { PlanChainParams } from "@/lib/api-types";
import { requireMerchant, requirePlanOfMerchant } from "@/lib/server/access";
import { dec, int, str } from "@/lib/server/db/rows";
import { route } from "@/lib/server/http";

export const GET = route<{ id: string }>(async (req, { sql, params }): Promise<PlanChainParams> => {
  const { merchant } = await requireMerchant(sql, req);
  const p = await requirePlanOfMerchant(sql, params.id, merchant.id);
  return {
    token: str(p.token_address),
    amount: dec(p.price),
    interval: int(p.billing_interval),
    trialPeriod: int(p.trial_seconds),
    introAmount: dec(p.intro_price),
    introPeriods: int(p.intro_periods),
    maxSubscribers: int(p.max_subscribers),
  };
});
