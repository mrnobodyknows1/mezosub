/**
 * Spend-cap arithmetic for a subscription's authorization (pure bigint math, unit tested).
 * A subscription may pull at most `remainingCap` in total; each charge costs the intro price for the first
 * `introPeriods` charges and the regular price afterwards.
 */
export interface ChargeTerms {
  amount: bigint; // regular price per period
  introAmount: bigint; // 0 when none
  introPeriods: number; // 0 when none
}

export const MAX_UINT128 = (1n << 128n) - 1n;
export const MAX_UINT256 = (1n << 256n) - 1n;

/** Price of the charge with index `periodIndex` (0 = first). */
export function chargeAt(t: ChargeTerms, periodIndex: number): bigint {
  return periodIndex < t.introPeriods && t.introAmount > 0n ? t.introAmount : t.amount;
}

/** Total cap needed to cover `periods` charges starting at charge index `fromPeriod`. */
export function capForPeriods(t: ChargeTerms, periods: number, fromPeriod = 0): bigint {
  if (!Number.isFinite(periods) || periods <= 0) return 0n;
  let total = 0n;
  for (let i = 0; i < Math.floor(periods); i++) total += chargeAt(t, fromPeriod + i);
  return total;
}

/** How many sequential charges (from `fromPeriod`) a cap covers. */
export function periodsCovered(t: ChargeTerms, cap: bigint, fromPeriod = 0, limit = 10_000): number {
  if (t.amount <= 0n || cap <= 0n) return 0;
  let left = cap;
  let n = 0;
  while (n < limit) {
    const c = chargeAt(t, fromPeriod + n);
    if (c <= 0n || left < c) break;
    left -= c;
    n++;
  }
  return n;
}

/**
 * Value for the EIP-2612 permit / approve: the current allowance PLUS the new cap, so another subscription's
 * headroom is never replaced. Returns null when the sum would overflow uint256, which only happens when the
 * wallet already has a near-unlimited allowance; then no new approval is needed at all.
 */
export function allowanceTarget(currentAllowance: bigint, spendCap: bigint): bigint | null {
  if (currentAllowance < 0n || spendCap < 0n) throw new Error("negative amount");
  const sum = currentAllowance + spendCap;
  return sum > MAX_UINT256 ? null : sum;
}

/** Whether the current allowance already covers everything the active subscriptions plus a new cap could pull. */
export function allowanceCovers(currentAllowance: bigint, committed: bigint, newCap: bigint): boolean {
  return currentAllowance >= committed + newCap;
}

/** Validate a cap the subscriber typed. Returns an error sentence or null. */
export function validateSpendCap(t: ChargeTerms, cap: bigint, firstChargeIndex = 0): string | null {
  if (cap > MAX_UINT128) return "That amount is too large.";
  const first = chargeAt(t, firstChargeIndex);
  if (cap < first) return "The limit has to cover at least one payment.";
  return null;
}
