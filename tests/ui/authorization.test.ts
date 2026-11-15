import { describe, expect, it } from "vitest";
import { allowanceCovers, allowanceTarget, capForPeriods, chargeAt, MAX_UINT256, periodsCovered, validateSpendCap } from "@/lib/client/authorization";
import { authorizationSentence, checkoutPeriodsFor, checkoutSpendCap, planAuthorization } from "@/lib/client/checkout";
import { checkoutFixture, wei } from "./fixtures";

const W = 10n ** 18n;
const plain = { amount: 10n * W, introAmount: 0n, introPeriods: 0 };
const intro = { amount: 10n * W, introAmount: 2n * W, introPeriods: 3 };

describe("permit / approve value", () => {
  it("is the current allowance plus the new cap", () => {
    expect(allowanceTarget(0n, 120n * W)).toBe(120n * W);
    expect(allowanceTarget(50n * W, 120n * W)).toBe(170n * W);
  });
  it("never replaces another subscription's headroom", () => {
    const p = planAuthorization(30n * W, 12n * W);
    expect(p).toEqual({ mode: "permit", value: 42n * W });
    expect(planAuthorization(30n * W, 12n * W, false)).toEqual({ mode: "approve", value: 42n * W });
  });
  it("skips approval when the allowance is already unlimited", () => {
    expect(allowanceTarget(MAX_UINT256, 1n)).toBeNull();
    expect(planAuthorization(MAX_UINT256, 12n * W)).toEqual({ mode: "direct" });
    expect(allowanceTarget(MAX_UINT256 - 5n, 5n)).toBe(MAX_UINT256);
  });
  it("checks coverage of committed caps", () => {
    expect(allowanceCovers(100n, 60n, 40n)).toBe(true);
    expect(allowanceCovers(99n, 60n, 40n)).toBe(false);
  });
});

describe("spend cap and periods", () => {
  it("is periods × price without intro pricing", () => {
    expect(capForPeriods(plain, 12)).toBe(120n * W);
    expect(capForPeriods(plain, 0)).toBe(0n);
  });
  it("uses the intro price for the first payments", () => {
    expect(chargeAt(intro, 0)).toBe(2n * W);
    expect(chargeAt(intro, 3)).toBe(10n * W);
    expect(capForPeriods(intro, 5)).toBe(3n * 2n * W + 2n * 10n * W);
    // renewal after 4 payments only pays regular price
    expect(capForPeriods(intro, 2, 4)).toBe(20n * W);
  });
  it("counts how many payments a cap covers", () => {
    expect(periodsCovered(plain, 125n * W)).toBe(12);
    expect(periodsCovered(intro, 26n * W)).toBe(5);
    expect(periodsCovered(plain, 0n)).toBe(0);
  });
  it("validates the cap covers at least one payment", () => {
    expect(validateSpendCap(plain, 9n * W)).toMatch(/at least one payment/);
    expect(validateSpendCap(plain, 10n * W)).toBeNull();
  });
  it("works from a CheckoutDTO", () => {
    const c = checkoutFixture();
    expect(checkoutSpendCap(c, c.suggestedPeriods).toString()).toBe(c.suggestedSpendCap);
    expect(checkoutPeriodsFor(c, BigInt(wei(36)))).toBe(3);
  });
});

describe("authorization sentence", () => {
  it("says exactly what is allowed and never 'pay once'", () => {
    const s = authorizationSentence({ spendCap: 144n * W, price: 12n * W, intervalSeconds: 30 * 86400, merchantName: "Lumen Studio" });
    expect(s).toBe("You're allowing MezoSub to charge up to 144.00 MUSD in total, 12.00 MUSD per month, to Lumen Studio. Nothing else.");
    expect(s.toLowerCase()).not.toContain("pay once");
  });
});
