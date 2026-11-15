// Shared read queries for dashboards.
import type { Sql } from "./db";
import { addSeconds, clock } from "./clock";
import { configuredKeeperAddress } from "./keeper";
import { workerStatus } from "./worker";

export async function keeperAddressForDisplay(sql: Sql): Promise<string | null> {
  const w = await workerStatus(sql).catch(() => null);
  return w?.keeperAddress ?? configuredKeeperAddress();
}

export function since(days: number): Date {
  return addSeconds(clock.now(), -days * 86400);
}

/** SQL expression: the next charge amount of subscription alias `s`. */
export function amountDueExpr(sql: Sql) {
  return sql.raw("(CASE WHEN s.payments_count < s.intro_periods THEN s.intro_amount ELSE s.amount END)");
}

/** CSV cell, quoted and formula-injection safe. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r']/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
