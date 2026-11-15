// In-app notifications + webhook enqueueing. Both are deduped by a unique key, so every caller can be
// idempotent (the indexer and the tx-confirm endpoints may apply the same event).

import type { Sql } from "./db";
import { clock } from "./clock";

/** UI routes used in notification links (frontend: keep these paths or tell the backend). */
export const links = {
  subscriberSubscription: (id: string) => `/account/subscriptions/${id}`,
  merchantSubscription: (id: string) => `/merchant/subscribers/${id}`,
  merchantBilling: () => `/merchant/billing`,
};

export type NotificationKind =
  | "payment_succeeded"
  | "payment_failed"
  | "past_due"
  | "subscription_cancelled"
  | "new_subscriber"
  | "upcoming_charge";

export async function notify(
  tx: Sql,
  n: { address: string; kind: NotificationKind; title: string; body: string; link?: string | null; dedupeKey: string },
): Promise<void> {
  await tx`
    INSERT INTO notifications (address, kind, title, body, link, dedupe_key, created_at)
    VALUES (${n.address.toLowerCase()}, ${n.kind}, ${n.title}, ${n.body}, ${n.link ?? null}, ${n.dedupeKey}, ${clock.now()})
    ON CONFLICT (dedupe_key) DO NOTHING`;
}

export type WebhookEventType =
  | "subscription.created"
  | "payment.succeeded"
  | "payment.failed"
  | "subscription.cancelled"
  | "subscription.past_due"
  | "authorization.updated"
  | "refund.created"
  | "ping";

/** Queue a webhook (status 'skipped' when the merchant has no URL). Payload follows WebhookPayload. */
export async function enqueueWebhook(
  tx: Sql,
  w: { merchantId: string; type: WebhookEventType; dedupeKey: string; data: Record<string, unknown> },
): Promise<void> {
  const [m] = await tx<{ webhook_url: string | null }>`SELECT webhook_url FROM merchants WHERE id = ${w.merchantId}`;
  if (!m) return;
  const now = clock.now();
  const [row] = await tx<{ id: string }>`
    INSERT INTO webhook_events (merchant_id, event_type, dedupe_key, payload, status, next_attempt_at, created_at)
    VALUES (${w.merchantId}, ${w.type}, ${w.dedupeKey}, ${{}}::jsonb, ${m.webhook_url ? "pending" : "skipped"}, ${now}, ${now})
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id`;
  if (!row) return;
  const payload = { id: row.id, type: w.type, createdAt: now.toISOString(), data: w.data };
  await tx`UPDATE webhook_events SET payload = ${payload}::jsonb WHERE id = ${row.id}`;
}

export async function audit(tx: Sql, actor: string, action: string, resourceId: string | null, metadata: Record<string, unknown> = {}) {
  await tx`INSERT INTO audit_logs (actor, action, resource_id, metadata, created_at)
           VALUES (${actor}, ${action}, ${resourceId}, ${metadata}::jsonb, ${clock.now()})`;
}
