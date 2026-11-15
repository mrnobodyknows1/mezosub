import { describe, expect, it } from "vitest";
import { deriveSubscriptionState, type DerivedSubscriptionState } from "@/lib/chain/subscription-state";
import { JOB_STATUS, PLAN_STATUS, subscriptionStateMeta, SUBSCRIPTION_STATE, TONE_CLASS } from "@/lib/client/status";

describe("subscription state → label and colour", () => {
  const expected: Record<DerivedSubscriptionState, [string, string]> = {
    trialing: ["Trial", "info"],
    active: ["Active", "ok"],
    due: ["Payment due", "warn"],
    past_due: ["Past due", "bad"],
    expired: ["Expired", "idle"],
    cap_exhausted: ["Limit reached", "warn"],
    cancelled: ["Cancelled", "idle"],
  };
  it.each(Object.entries(expected))("%s", (state, [label, tone]) => {
    const m = subscriptionStateMeta(state as DerivedSubscriptionState);
    expect(m.label).toBe(label);
    expect(m.tone).toBe(tone);
    expect(TONE_CLASS[m.tone].text).toBeTruthy();
  });
  it("covers every derived state", () => {
    expect(Object.keys(SUBSCRIPTION_STATE).sort()).toEqual(Object.keys(expected).sort());
  });
  it("maps derived chain state end to end", () => {
    const base = { status: 1, amount: 10n, introAmount: 0n, introPeriods: 0, paymentsCount: 1, remainingCap: 100n, expiresAt: 0n, nextBillingAt: 200n };
    expect(subscriptionStateMeta(deriveSubscriptionState(base, 100n)).label).toBe("Active");
    expect(subscriptionStateMeta(deriveSubscriptionState(base, 300n)).label).toBe("Payment due");
    expect(subscriptionStateMeta(deriveSubscriptionState({ ...base, remainingCap: 5n }, 100n)).label).toBe("Limit reached");
  });
  it("labels plan and job statuses", () => {
    expect(PLAN_STATUS.active.label).toBe("Live");
    expect(JOB_STATUS.failed_final.tone).toBe("bad");
  });
});
