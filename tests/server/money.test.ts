import { describe, expect, it } from "vitest";
import { formatMusd, monthlyNormalized, musdToDecimalString, MUSD_UNIT, parseMusd, tryParseMusd } from "@/lib/money";

describe("money", () => {
  it("parses human amounts", () => {
    expect(parseMusd("5")).toBe(5n * MUSD_UNIT);
    expect(parseMusd("4.99")).toBe(4_990_000_000_000_000_000n);
    expect(parseMusd(" 1,000.5 ")).toBe(1000n * MUSD_UNIT + MUSD_UNIT / 2n);
    expect(parseMusd(".5")).toBe(MUSD_UNIT / 2n);
    expect(parseMusd("0.000000000000000001")).toBe(1n);
  });
  it("rejects invalid amounts", () => {
    for (const bad of ["", "-1", "abc", "1.2.3", "1e18", ".", "0.0000000000000000001"]) expect(() => parseMusd(bad)).toThrow();
    expect(tryParseMusd("x")).toBeNull();
  });
  it("formats", () => {
    expect(formatMusd(4_990_000_000_000_000_000n)).toBe("4.99");
    expect(formatMusd("5000000000000000000", { symbol: true })).toBe("5.00 MUSD");
    expect(formatMusd(1234567n * MUSD_UNIT)).toBe("1,234,567.00");
    expect(formatMusd(4_995_000_000_000_000_000n)).toBe("5.00"); // half-up
    expect(formatMusd(1n)).toBe("<0.01");
    expect(formatMusd(0n)).toBe("0.00");
    expect(formatMusd(1500n * MUSD_UNIT, { compact: true })).toBe("1.5K");
    expect(formatMusd(2_000_000n * MUSD_UNIT, { compact: true })).toBe("2M");
    expect(formatMusd(5n * MUSD_UNIT, { decimals: 0 })).toBe("5");
    expect(formatMusd(-5n * MUSD_UNIT)).toBe("-5.00");
    expect(musdToDecimalString(4_990_000_000_000_000_000n)).toBe("4.99");
  });
  it("normalises to 30-day months", () => {
    expect(monthlyNormalized(10n * MUSD_UNIT, 30 * 86400)).toBe(10n * MUSD_UNIT);
    expect(monthlyNormalized(12n * MUSD_UNIT, 365 * 86400)).toBe((12n * MUSD_UNIT * 2592000n) / 31536000n);
    expect(monthlyNormalized(7n * MUSD_UNIT, 7 * 86400)).toBe(30n * MUSD_UNIT);
    expect(monthlyNormalized(5n * MUSD_UNIT, 300)).toBe(5n * MUSD_UNIT * 8640n);
    expect(monthlyNormalized(5n, 0)).toBe(0n);
  });
});
