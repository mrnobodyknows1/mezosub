// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutSummary } from "@/components/checkout/checkout-summary";
import { checkoutSpendCap } from "@/lib/client/checkout";
import { checkoutFixture, wei } from "./fixtures";
import { render, type Rendered } from "./render";

let r: Rendered | null = null;
afterEach(() => {
  r?.unmount();
  r = null;
});

describe("CheckoutSummary", () => {
  it("renders price, first charge, limit, policy and contract info from a CheckoutDTO", () => {
    const c = checkoutFixture();
    r = render(<CheckoutSummary checkout={c} spendCap={checkoutSpendCap(c, 12)} periods={12} expiresAt={0n} />);
    expect(r.byTestId("price")?.textContent).toBe("12.00");
    expect(r.text()).toContain("MUSD per month");
    expect(r.text()).toContain("Charged today");
    expect(r.byTestId("first-charge")?.textContent).toBe("12.00 MUSD");
    expect(r.byTestId("spend-cap")?.textContent).toBe("144.00 MUSD");
    expect(r.text()).toContain("Covers 12 payments");
    expect(r.text()).toContain("No end date");
    expect(r.text()).toContain("Cancel anytime. Past payments aren't reversed automatically.");
    expect(r.text()).toContain("Lumen Studio");
    expect(r.text()).toContain("Mezo Testnet (31611)");
    const links = r.byRole("link").map((a) => a.getAttribute("href"));
    expect(links).toContain("https://explorer.test.mezo.org/address/0x3333333333333333333333333333333333333333");
    expect(r.text().toLowerCase()).not.toContain("pay once");
  });

  it("shows trial, intro price and the testnet demo note", () => {
    const c = checkoutFixture({ billingInterval: 300, intervalLabel: "Every 5 minutes (testnet demo)", trialSeconds: 600, introPrice: wei(2), introPeriods: 2 });
    c.firstCharge = { amount: wei(2), at: "2026-11-09T12:10:00.000Z" };
    r = render(<CheckoutSummary checkout={c} spendCap={checkoutSpendCap(c, 3)} periods={3} expiresAt={0n} />);
    expect(r.text()).toContain("10-minute free trial");
    expect(r.text()).toContain("for the first 2 payments");
    expect(r.text()).toContain("Testnet demo");
    expect(r.text()).toContain("First payment");
    expect(r.byTestId("spend-cap")?.textContent).toBe("16.00 MUSD");
  });
});
