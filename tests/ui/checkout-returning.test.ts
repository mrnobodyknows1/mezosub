import { describe, expect, it } from "vitest";
import { checkoutForReturning, checkoutSpendCap } from "@/lib/client/checkout";
import type { CheckoutDTO } from "@/lib/api-types";

const base = {
  plan: { price: "10000000000000000000", introPrice: "1000000000000000000", introPeriods: 1, trialSeconds: 604800, billingInterval: 2592000 },
  firstCharge: { amount: "1000000000000000000", at: "2026-11-19T00:00:00.000Z" },
  secondCharge: { amount: "10000000000000000000", at: "2026-12-19T00:00:00.000Z" },
} as unknown as CheckoutDTO;

describe("checkoutForReturning (audit fix: trial and intro once per wallet)", () => {
  it("charges the full price now, with no trial or intro", () => {
    const now = new Date("2026-11-12T00:00:00.000Z");
    const r = checkoutForReturning(base, now);
    expect(r.plan.trialSeconds).toBe(0);
    expect(r.plan.introPeriods).toBe(0);
    expect(r.firstCharge).toEqual({ amount: "10000000000000000000", at: now.toISOString() });
    expect(r.secondCharge.at).toBe("2026-12-12T00:00:00.000Z");
    // spend cap for 3 payments = 3 x full price (no intro discount)
    expect(checkoutSpendCap(r, 3)).toBe(30_000000000000000000n);
    expect(checkoutSpendCap(base, 3)).toBe(21_000000000000000000n);
  });
});
