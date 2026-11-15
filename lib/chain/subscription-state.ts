// FROZEN. Pure, isomorphic derivation of a subscription's display state from on-chain fields.
// Used by API (DTOs), worker (scheduling) and UI. All amounts are bigint token units, times unix seconds.

export type DerivedSubscriptionState =
  | "trialing" // never charged, trial still running
  | "active" // paid up, next charge in the future
  | "due" // next charge reached, collectible
  | "past_due" // due and the off-chain retry window is exhausted (needs billingFailedFinal flag)
  | "expired" // authorization expiry reached
  | "cap_exhausted" // remaining authorization cannot cover the next charge
  | "cancelled";

export interface ChainSubscriptionFields {
  status: number; // 0 none, 1 active, 2 cancelled
  amount: bigint;
  introAmount: bigint;
  introPeriods: number;
  paymentsCount: number;
  remainingCap: bigint;
  expiresAt: bigint; // 0 = none
  nextBillingAt: bigint;
}

export function amountDueOf(s: Pick<ChainSubscriptionFields, "amount" | "introAmount" | "introPeriods" | "paymentsCount">): bigint {
  return s.paymentsCount < s.introPeriods ? s.introAmount : s.amount;
}

export function deriveSubscriptionState(
  s: ChainSubscriptionFields,
  nowSec: bigint,
  opts: { billingFailedFinal?: boolean } = {},
): DerivedSubscriptionState {
  if (s.status === 2) return "cancelled";
  if (s.expiresAt !== 0n && nowSec >= s.expiresAt) return "expired";
  if (s.remainingCap < amountDueOf(s)) return "cap_exhausted";
  if (nowSec < s.nextBillingAt) return s.paymentsCount === 0 ? "trialing" : "active";
  return opts.billingFailedFinal ? "past_due" : "due";
}
