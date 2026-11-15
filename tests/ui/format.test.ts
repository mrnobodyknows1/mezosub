import { describe, expect, it } from "vitest";
import { BILLING_INTERVALS } from "@/lib/chain/config";
import { intervalLabel, intervalNoun, isDemoInterval, musd, musdExact, perInterval, priceLabel, shortAddress, trialLabel } from "@/lib/client/format";

const W = 10n ** 18n;

describe("musd amounts", () => {
  it("formats wei with 2 decimals and grouping", () => {
    expect(musd(1234n * W + W / 2n)).toBe("1,234.50");
    expect(musd("4990000000000000000")).toBe("4.99");
    expect(musd(0n)).toBe("0.00");
  });
  it("compact abbreviates", () => {
    expect(musd(1234n * W, { compact: true })).toBe("1.2K");
    expect(musd(2_500_000n * W, { compact: true })).toBe("2.5M");
  });
  it("shows a tiny marker instead of zero for dust", () => {
    expect(musd(10n ** 14n)).toBe("<0.01");
  });
  it("never shows NaN or crashes on bad input", () => {
    expect(musd(null)).toBe("--");
    expect(musd(undefined)).toBe("--");
    expect(musd("abc")).toBe("--");
  });
  it("exact keeps full precision", () => {
    expect(musdExact(1234567890000000000n)).toBe("1.23456789");
    expect(musdExact(5n * W)).toBe("5");
  });
});

describe("intervals", () => {
  it("names the standard intervals", () => {
    expect(intervalNoun(BILLING_INTERVALS.monthly.seconds)).toBe("month");
    expect(perInterval(BILLING_INTERVALS.weekly.seconds)).toBe("per week");
    expect(perInterval(BILLING_INTERVALS.yearly.seconds)).toBe("per year");
    expect(intervalLabel(BILLING_INTERVALS.quarterly.seconds)).toBe("Quarterly");
  });
  it("labels the demo interval as a testnet demo", () => {
    expect(isDemoInterval(300)).toBe(true);
    expect(intervalLabel(300)).toBe("Every 5 minutes (testnet demo)");
    expect(perInterval(300)).toBe("every 5 minutes");
  });
  it("handles custom intervals", () => {
    expect(intervalLabel(12 * 86400)).toBe("Every 12 days");
    expect(perInterval(12 * 86400)).toBe("every 12 days");
  });
  it("builds price labels", () => {
    expect(priceLabel(12n * W, 30 * 86400)).toBe("12.00 MUSD per month");
  });
  it("labels trials", () => {
    expect(trialLabel(0)).toBeNull();
    expect(trialLabel(14 * 86400)).toBe("14-day free trial");
    expect(trialLabel(600)).toBe("10-minute free trial");
  });
  it("shortens addresses", () => {
    expect(shortAddress("0x1234567890abcdef1234567890abcdef12345678")).toBe("0x1234…5678");
    expect(shortAddress(null)).toBe("--");
  });
});
