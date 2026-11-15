import { z } from "zod";
import type { Paginated, SubscriptionDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { merchantForAddress } from "@/lib/server/access";
import { clock } from "@/lib/server/clock";
import { subscriptionSelect, toSubscriptionDTO } from "@/lib/server/dto";
import { forbidden } from "@/lib/server/errors";
import { parseQuery, route, zPage, zPageSize } from "@/lib/server/http";

const q = z.object({
  scope: z.enum(["merchant", "subscriber"]).default("subscriber"),
  status: z
    .enum(["active", "trialing", "due", "past_due", "cap_exhausted", "expired", "cancelled", "retrying", "all", ""])
    .optional(),
  page: zPage,
  pageSize: zPageSize,
});

export const GET = route(async (req, { sql }): Promise<Paginated<SubscriptionDTO>> => {
  const session = await requireSession(sql, req);
  const { scope, status, page, pageSize } = parseQuery(req, q);
  let owner;
  if (scope === "merchant") {
    const m = await merchantForAddress(sql, session.address);
    if (!m) throw forbidden("Create a merchant profile first");
    owner = sql.frag`s.merchant_id = ${m.id}`;
  } else owner = sql.frag`s.subscriber_address = ${session.address}`;
  const now = clock.now();
  // Derived-state filters mirror deriveSubscriptionState (lib/chain/subscription-state.ts) in SQL.
  const live = sql.frag`s.status = 'active'`;
  const notExpired = sql.frag`(s.expires_at IS NULL OR s.expires_at > ${now})`;
  const capOk = sql.frag`s.remaining_cap >= (CASE WHEN s.payments_count < s.intro_periods THEN s.intro_amount ELSE s.amount END)`;
  const healthy = sql.frag`${live} AND ${notExpired} AND ${capOk}`;
  const filter =
    status === "cancelled" ? sql.frag`AND s.status = 'cancelled'`
    : status === "expired" ? sql.frag`AND ${live} AND s.expires_at IS NOT NULL AND s.expires_at <= ${now}`
    : status === "cap_exhausted" ? sql.frag`AND ${live} AND ${notExpired} AND NOT ${capOk}`
    : status === "trialing" ? sql.frag`AND ${healthy} AND s.next_billing_at > ${now} AND s.payments_count = 0`
    : status === "active" ? sql.frag`AND ${healthy} AND s.next_billing_at > ${now} AND s.payments_count > 0`
    : status === "due" ? sql.frag`AND ${healthy} AND s.next_billing_at <= ${now} AND s.billing_status <> 'past_due'`
    : status === "past_due" ? sql.frag`AND ${healthy} AND s.next_billing_at <= ${now} AND s.billing_status = 'past_due'`
    : status === "retrying" ? sql.frag`AND ${live} AND s.billing_status = 'retrying'`
    : sql.frag``;
  const [{ n }] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM subscriptions s WHERE ${owner} ${filter}`;
  const rows = await sql<Record<string, unknown>>`
    ${subscriptionSelect(sql)} WHERE ${owner} ${filter}
    ORDER BY s.created_at DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  return { items: rows.map(toSubscriptionDTO), total: Number(n), page, pageSize };
});
