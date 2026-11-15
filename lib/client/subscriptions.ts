import type { Hash } from "viem";
import type { SubscriptionDTO } from "@/lib/api-types";
import { api } from "./api";
import type { ChargeTerms } from "./authorization";

/** After any subscription tx: the API verifies the receipt and re-reads the chain. */
export function syncSubscription(id: string, txHash?: Hash) {
  return api<SubscriptionDTO>(`/api/subscriptions/${id}/sync`, { method: "POST", json: txHash ? { txHash } : {} });
}

export function retrySubscription(id: string) {
  return api<unknown>(`/api/subscriptions/${id}/retry`, { method: "POST", json: {} });
}

export function termsOf(s: Pick<SubscriptionDTO, "amount" | "introAmount" | "introPeriods">): ChargeTerms {
  return { amount: BigInt(s.amount), introAmount: BigInt(s.introAmount || "0"), introPeriods: s.introPeriods };
}

/** <input type="date"> value → unix seconds at the end of that local day; "" → 0n (no end date). */
export function expiryFromDateInput(v: string): bigint {
  if (!v) return 0n;
  const d = new Date(`${v}T23:59:59`);
  if (Number.isNaN(d.getTime())) return 0n;
  return BigInt(Math.floor(d.getTime() / 1000));
}

export function dateInputFromIso(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayInput(offsetDays = 1): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** True when a chosen end date (unix seconds, 0n = none) is not in the future. */
export function isPastExpiry(expiresAt: bigint, nowMs: number = Date.now()): boolean {
  return expiresAt !== 0n && expiresAt * 1000n <= BigInt(nowMs);
}
