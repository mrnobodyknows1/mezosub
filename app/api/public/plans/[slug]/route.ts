import type { CheckoutDTO, PlanStatus } from "@/lib/api-types";
import { CHAIN_MERCHANT_STATUS, CHAIN_PLAN_STATUS, MEZO_TESTNET_ID, contracts, intervalKeyOf, isDeployed } from "@/lib/chain/config";
import { getChain } from "@/lib/server/chain";
import { addSeconds, clock } from "@/lib/server/clock";
import { big } from "@/lib/server/db/rows";
import { intervalLabel, planSelect, toPublicPlanDTO, toPublicMerchantDTO } from "@/lib/server/dto";
import { notFound, unavailable } from "@/lib/server/errors";
import { route } from "@/lib/server/http";

const SUGGESTED: Record<string, number> = { weekly: 52, monthly: 12, quarterly: 4, yearly: 2, demo_5m: 12 };

export const GET = route<{ slug: string }>(
  async (_req, { sql, params }): Promise<CheckoutDTO> => {
    const slug = String(params.slug || "").toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw notFound("Plan not found");
    const [row] = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.slug = ${slug}`;
    if (!row || row.onchain_plan_id === null || row.status === "draft") throw notFound("Plan not found");
    const [m] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE id = ${String(row.merchant_id)}`;
    if (!isDeployed) throw unavailable("not_deployed", "Contracts are not deployed yet");

    const chain = getChain();
    let livePlan, liveMerchant;
    try {
      livePlan = await chain.getPlan(big(row.onchain_plan_id));
      liveMerchant = await chain.getMerchant(livePlan.merchantId);
    } catch {
      throw unavailable("chain_unavailable", "Couldn't reach Mezo right now. Please retry in a moment.");
    }
    const planStatus = (CHAIN_PLAN_STATUS[livePlan.status] === "none" ? "archived" : CHAIN_PLAN_STATUS[livePlan.status]) as PlanStatus;
    const merchantStatus = CHAIN_MERCHANT_STATUS[liveMerchant.status];
    const full = livePlan.maxSubscribers > 0 && livePlan.activeSubscribers >= livePlan.maxSubscribers;
    const reason =
      planStatus === "paused"
        ? "This plan is paused and not accepting new subscribers."
        : planStatus === "archived"
          ? "This plan is no longer available."
          : merchantStatus !== "active"
            ? "This merchant isn't accepting new subscribers right now."
            : full
              ? "This plan is full."
              : null;

    // Live terms win over the DB copy.
    const plan = toPublicPlanDTO({
      ...row,
      price: livePlan.amount.toString(),
      billing_interval: livePlan.interval,
      trial_seconds: livePlan.trialPeriod,
      intro_price: livePlan.introAmount.toString(),
      intro_periods: livePlan.introPeriods,
      max_subscribers: livePlan.maxSubscribers,
      terms_version: livePlan.termsVersion,
      token_address: livePlan.token.toLowerCase(),
      status: planStatus,
    });
    plan.intervalLabel = intervalLabel(livePlan.interval);

    const amountFor = (i: number) => (i < livePlan.introPeriods ? livePlan.introAmount : livePlan.amount);
    const now = clock.now();
    const firstAt = addSeconds(now, livePlan.trialPeriod);
    const secondAt = addSeconds(firstAt, livePlan.interval);
    const key = intervalKeyOf(livePlan.interval);
    const periods = (key && SUGGESTED[key]) || 12;
    let cap = 0n;
    for (let i = 0; i < periods; i++) cap += amountFor(i);

    return {
      plan,
      merchant: toPublicMerchantDTO({ ...m, chain_status: merchantStatus === "none" ? "pending" : merchantStatus }),
      managerAddress: contracts.manager.toLowerCase(),
      chainId: MEZO_TESTNET_ID,
      live: {
        planStatus,
        termsVersion: livePlan.termsVersion,
        activeSubscribers: livePlan.activeSubscribers,
        acceptingSubscribers: reason === null,
        reason,
      },
      firstCharge: { amount: amountFor(0).toString(), at: (livePlan.trialPeriod > 0 ? firstAt : now).toISOString() },
      secondCharge: { amount: amountFor(1).toString(), at: secondAt.toISOString() },
      suggestedSpendCap: cap.toString(),
      suggestedPeriods: periods,
    };
  },
  { rateLimit: { bucket: "public_plan", limit: 120 } },
);
