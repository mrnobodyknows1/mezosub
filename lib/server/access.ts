// Authorization helpers (framework-free; unit-tested).

import type { Sql } from "./db";
import { requireSession, type Session } from "./auth";
import { forbidden, notFound } from "./errors";
import { subscriptionSelect } from "./dto";

export type MerchantRow = Record<string, unknown> & {
  id: string;
  wallet_address: string;
  onchain_merchant_id: string | number | null;
  chain_status: string;
};

export async function merchantForAddress(sql: Sql, address: string): Promise<MerchantRow | null> {
  const [m] = await sql<MerchantRow>`SELECT * FROM merchants WHERE wallet_address = ${address.toLowerCase()}`;
  return m ?? null;
}

/** Session wallet must own a merchant profile (merchants.wallet_address == session address). */
export async function requireMerchant(sql: Sql, req: Request): Promise<{ session: Session; merchant: MerchantRow }> {
  const session = await requireSession(sql, req);
  const merchant = await merchantForAddress(sql, session.address);
  if (!merchant) throw forbidden("Create a merchant profile first");
  return { session, merchant };
}

/** Like requireMerchant but also requires a confirmed on-chain registration. */
export async function requireRegisteredMerchant(sql: Sql, req: Request) {
  const r = await requireMerchant(sql, req);
  if (r.merchant.onchain_merchant_id === null || r.merchant.onchain_merchant_id === undefined) {
    throw forbidden("Register your merchant account on-chain first");
  }
  return r;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `:id` accepts the DB uuid or the on-chain subscription id. */
export function subscriptionWhere(sql: Sql, idParam: string) {
  if (UUID_RE.test(idParam)) return sql.frag`s.id = ${idParam.toLowerCase()}`;
  if (/^\d{1,30}$/.test(idParam)) return sql.frag`s.onchain_subscription_id = ${idParam}`;
  throw notFound("Subscription not found");
}

/** Visible only to its subscriber or the merchant that owns it. */
export async function loadSubscriptionForViewer(
  sql: Sql,
  idParam: string,
  address: string,
): Promise<{ row: Record<string, unknown>; role: "subscriber" | "merchant" }> {
  const [row] = await sql<Record<string, unknown>>`
    ${subscriptionSelect(sql)} WHERE ${subscriptionWhere(sql, idParam)}`;
  if (!row) throw notFound("Subscription not found");
  const a = address.toLowerCase();
  if (String(row.subscriber_address) === a) return { row, role: "subscriber" };
  const [m] = await sql<{ wallet_address: string }>`SELECT wallet_address FROM merchants WHERE id = ${String(row.merchant_id)}`;
  if (m && m.wallet_address === a) return { row, role: "merchant" };
  // Same response as "missing" would leak existence; 403 is clearer for the UI and ids are public on-chain anyway.
  throw forbidden("Only the subscriber or the merchant can view this subscription");
}

export async function requirePlanOfMerchant(sql: Sql, planId: string, merchantId: string): Promise<Record<string, unknown>> {
  if (!UUID_RE.test(planId)) throw notFound("Plan not found");
  const [p] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${planId}`;
  if (!p) throw notFound("Plan not found");
  if (String(p.merchant_id) !== merchantId) throw forbidden("This plan belongs to another merchant");
  return p;
}
