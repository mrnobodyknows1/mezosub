import type { CheckoutDTO } from "@/lib/api-types";
import { allowanceTarget, capForPeriods, periodsCovered, type ChargeTerms } from "./authorization";
import { musd, perInterval } from "./format";

export function checkoutTerms(c: CheckoutDTO): ChargeTerms {
  return { amount: BigInt(c.plan.price), introAmount: BigInt(c.plan.introPrice || "0"), introPeriods: c.plan.introPeriods };
}

/** Spending limit for `periods` payments from the first one. */
export function checkoutSpendCap(c: CheckoutDTO, periods: number): bigint {
  return capForPeriods(checkoutTerms(c), periods, 0);
}

export function checkoutPeriodsFor(c: CheckoutDTO, cap: bigint): number {
  return periodsCovered(checkoutTerms(c), cap, 0);
}

/** The sentence shown right before the wallet opens. Never says "pay once". */
export function authorizationSentence(args: { spendCap: bigint; price: bigint | string; intervalSeconds: number; merchantName: string }): string {
  return `You're allowing MezoSub to charge up to ${musd(args.spendCap)} MUSD in total, ${musd(args.price)} MUSD ${perInterval(args.intervalSeconds)}, to ${args.merchantName}. Nothing else.`;
}

export type AuthorizationPlan =
  | { mode: "direct" } // allowance already effectively unlimited
  | { mode: "permit"; value: bigint } // EIP-2612 signature, then subscribeWithPermit
  | { mode: "approve"; value: bigint }; // approve, then subscribe

/** Decide how to authorize: permit value / approve amount = current allowance + new cap. */
export function planAuthorization(currentAllowance: bigint, spendCap: bigint, preferPermit = true): AuthorizationPlan {
  const value = allowanceTarget(currentAllowance, spendCap);
  if (value === null) return { mode: "direct" };
  return preferPermit ? { mode: "permit", value } : { mode: "approve", value };
}

/**
 * Trial and intro pricing apply once per wallet per plan (the contract records `hasSubscribed`). For a returning
 * wallet the contract charges the full price at subscribe, so checkout shows the same.
 */
export function checkoutForReturning(c: CheckoutDTO, now: Date = new Date()): CheckoutDTO {
  const price = c.plan.price;
  return {
    ...c,
    plan: { ...c.plan, trialSeconds: 0, introPeriods: 0, introPrice: "0" },
    firstCharge: { amount: price, at: now.toISOString() },
    secondCharge: { amount: price, at: new Date(now.getTime() + c.plan.billingInterval * 1000).toISOString() },
  };
}
