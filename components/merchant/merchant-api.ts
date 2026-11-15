import type { ConfirmTxRequest, Hex } from "@/lib/api-types";
import { api } from "@/lib/client/api";

/** POST helpers for tx-confirm endpoints (server verifies receipt + logs + sender). */
export const confirmMerchantTx = (hash: Hex) => api<unknown>("/api/merchants/me/confirm", { method: "POST", json: { txHash: hash } satisfies ConfirmTxRequest });
export const confirmPlanTx = (planId: string, hash: Hex) =>
  api<unknown>(`/api/plans/${planId}/confirm`, { method: "POST", json: { txHash: hash } satisfies ConfirmTxRequest });
export const syncSubscriptionTx = (subId: string, hash?: Hex) =>
  api<unknown>(`/api/subscriptions/${subId}/sync`, { method: "POST", json: hash ? ({ txHash: hash } satisfies ConfirmTxRequest) : {} });

/** "1 day, then 2 days" from [86400, 172800]. */
export function describeDelays(delays: number[]): string {
  const words = delays.map((s) => {
    if (s % 86400 === 0) return s === 86400 ? "1 day" : `${s / 86400} days`;
    if (s % 3600 === 0) return s === 3600 ? "1 hour" : `${s / 3600} hours`;
    const m = Math.round(s / 60);
    return m === 1 ? "1 minute" : `${m} minutes`;
  });
  if (words.length === 0) return "no retries";
  if (words.length === 1) return `after ${words[0]}`;
  return `after ${words.slice(0, -1).join(", ")}, then ${words[words.length - 1]}`;
}
