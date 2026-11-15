import { BILLING_INTERVALS, intervalKeyOf } from "@/lib/chain/config";
import { formatMusd } from "@/lib/money";

/** Display-only helpers. Amounts stay bigint/wei strings everywhere else. */

const DASH = "--";

function toWei(v: bigint | string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (!/^-?\d+$/.test(v.trim())) return null;
  return BigInt(v.trim());
}

/** "1,234.50" (detailed) or "1.2K" (compact). Null/invalid → "--". Never "-0.00". */
export function musd(v: bigint | string | null | undefined, opts: { compact?: boolean; decimals?: number; symbol?: boolean } = {}): string {
  const wei = toWei(v);
  if (wei === null) return DASH;
  const out = formatMusd(wei, { decimals: opts.decimals ?? 2, compact: opts.compact, symbol: opts.symbol });
  return /^-0(\.0+)?( MUSD)?$/.test(out) ? out.slice(1) : out;
}

/** Full precision with trailing zeros trimmed (for aria-labels and copy). */
export function musdExact(v: bigint | string | null | undefined): string {
  const wei = toWei(v);
  if (wei === null) return DASH;
  const neg = wei < 0n;
  const abs = neg ? -wei : wei;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toString()}${frac ? "." + frac : ""}`;
}

export function isDemoInterval(seconds: number): boolean {
  return seconds === BILLING_INTERVALS.demo_5m.seconds;
}

function durationWords(seconds: number): string {
  if (seconds % 86400 === 0) {
    const d = seconds / 86400;
    return d === 1 ? "day" : `${d} days`;
  }
  if (seconds % 3600 === 0) {
    const h = seconds / 3600;
    return h === 1 ? "hour" : `${h} hours`;
  }
  const m = Math.round(seconds / 60);
  return m === 1 ? "minute" : `${m} minutes`;
}

/** "week" | "month" | "quarter" | "year" | "5 minutes" | "12 days" */
export function intervalNoun(seconds: number): string {
  switch (intervalKeyOf(seconds)) {
    case "weekly":
      return "week";
    case "monthly":
      return "month";
    case "quarterly":
      return "quarter";
    case "yearly":
      return "year";
    case "demo_5m":
      return "5 minutes";
    default:
      return durationWords(seconds);
  }
}

/** "per month" | "every 5 minutes" | "every 12 days" */
export function perInterval(seconds: number): string {
  const key = intervalKeyOf(seconds);
  if (key && key !== "demo_5m") return `per ${intervalNoun(seconds)}`;
  return `every ${intervalNoun(seconds)}`;
}

/** "Monthly" | "Every 5 minutes (testnet demo)" | "Every 12 days" */
export function intervalLabel(seconds: number): string {
  const key = intervalKeyOf(seconds);
  if (key) return BILLING_INTERVALS[key].label;
  return `Every ${durationWords(seconds)}`;
}

/** "12.50 MUSD per month" */
export function priceLabel(amount: bigint | string, seconds: number): string {
  return `${musd(amount)} MUSD ${perInterval(seconds)}`;
}

/** "14-day free trial" | "5-minute free trial" | null */
export function trialLabel(seconds: number): string | null {
  if (!seconds) return null;
  if (seconds % 86400 === 0) return `${seconds / 86400}-day free trial`;
  if (seconds % 3600 === 0) return `${seconds / 3600}-hour free trial`;
  return `${Math.round(seconds / 60)}-minute free trial`;
}

export function shortAddress(a: string | null | undefined): string {
  if (!a) return DASH;
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
export const shortHash = (h: string | null | undefined) => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : DASH);

function toDate(v: string | number | Date | null | undefined): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  return d ? d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : DASH;
}

export function formatDateTime(v: string | number | Date | null | undefined): string {
  const d = toDate(v);
  return d ? d.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : DASH;
}

/** Short-interval plans need the time too; long ones just the date. */
export function formatBillingDate(v: string | null | undefined, intervalSeconds: number): string {
  return intervalSeconds < 86400 ? formatDateTime(v) : formatDate(v);
}

/** "in 3 days" / "5 minutes ago" / "now". */
export function relativeTime(v: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = toDate(v);
  if (!d) return DASH;
  const diff = d.getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return "now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "minute") return rtf.format(Math.round(diff / ms), unit);
  }
  return DASH;
}

export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}
