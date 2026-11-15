// Row → DTO mappers (exact shapes from lib/api-types.ts) and the shared SELECTs that feed them.

import type {
  BillingJobDTO,
  MerchantDTO,
  NotificationDTO,
  PaymentDTO,
  PlanDTO,
  PublicMerchantDTO,
  SubscriptionDTO,
  MerchantChainStatus,
  PlanStatus,
  BillingStatus,
  BillingJobStatus,
} from "@/lib/api-types";
import { BILLING_INTERVALS, COLLECTION_CHECK, MUSD_DECIMALS, MUSD_SYMBOL, explorerTx, intervalKeyOf, merchantMetadataURI, type CollectionCheck } from "@/lib/chain/config";
import { amountDueOf, deriveSubscriptionState } from "@/lib/chain/subscription-state";
import type { Sql } from "./db";
import { big, bool, dec, int, iso, isoOrNull, json, str, strOrNull } from "./db/rows";
import { clock } from "./clock";
import { env } from "./env";

type R = Record<string, unknown>;

export function intervalLabel(seconds: number): string {
  const key = intervalKeyOf(seconds);
  if (key) return BILLING_INTERVALS[key].label;
  if (seconds % 86400 === 0) return seconds === 86400 ? "Daily" : `Every ${seconds / 86400} days`;
  if (seconds % 3600 === 0) return seconds === 3600 ? "Hourly" : `Every ${seconds / 3600} hours`;
  if (seconds % 60 === 0) return `Every ${seconds / 60} minutes`;
  return `Every ${seconds} seconds`;
}

export function checkoutUrl(slug: string): string {
  return `${env.appUrl()}/subscribe/${slug}`;
}

// ---------------------------------------------------------------- merchants

export function toMerchantDTO(r: R): MerchantDTO {
  return {
    id: str(r.id),
    onchainMerchantId: r.onchain_merchant_id === null || r.onchain_merchant_id === undefined ? null : dec(r.onchain_merchant_id),
    walletAddress: str(r.wallet_address),
    payoutAddress: strOrNull(r.payout_address),
    chainStatus: str(r.chain_status) as MerchantChainStatus,
    keeperEnabled: bool(r.keeper_enabled),
    name: str(r.name),
    slug: str(r.slug),
    description: str(r.description),
    logoUrl: strOrNull(r.logo_url),
    website: strOrNull(r.website),
    supportEmail: strOrNull(r.support_email),
    webhookUrl: strOrNull(r.webhook_url),
    hasWebhookSecret: Boolean(r.webhook_secret),
    notifyOnPayment: bool(r.notify_on_payment),
    notifyOnFailure: bool(r.notify_on_failure),
    metadataURI: merchantMetadataURI(str(r.id)),
    registerTxHash: strOrNull(r.register_tx_hash),
    createdAt: iso(r.created_at),
  };
}

export function toPublicMerchantDTO(r: R): PublicMerchantDTO {
  return {
    id: str(r.id),
    name: str(r.name),
    slug: str(r.slug),
    description: str(r.description),
    logoUrl: strOrNull(r.logo_url),
    website: strOrNull(r.website),
    supportEmail: strOrNull(r.support_email),
    walletAddress: str(r.wallet_address),
    payoutAddress: strOrNull(r.payout_address),
    chainStatus: str(r.chain_status) as MerchantChainStatus,
  };
}

// ---------------------------------------------------------------- plans

/** SELECT for PlanDTO: plan columns + active_subs + mrr. Append WHERE/ORDER via fragment. */
export function planSelect(sql: Sql) {
  return sql.frag`
    SELECT p.*,
      (SELECT count(*)::int FROM subscriptions s WHERE s.plan_id = p.id AND s.status = 'active') AS active_subs,
      (SELECT COALESCE(sum(trunc(s.amount * 2592000 / s.billing_interval)), 0)::text FROM subscriptions s
         WHERE s.plan_id = p.id AND s.status = 'active') AS mrr
    FROM plans p`;
}

export function toPlanDTO(r: R): PlanDTO {
  const interval = int(r.billing_interval);
  return {
    tokenAddress: str(r.token_address),
    tokenSymbol: MUSD_SYMBOL,
    tokenDecimals: MUSD_DECIMALS,
    price: dec(r.price),
    billingInterval: interval,
    intervalLabel: intervalLabel(interval),
    trialSeconds: int(r.trial_seconds),
    introPrice: dec(r.intro_price),
    introPeriods: int(r.intro_periods),
    maxSubscribers: int(r.max_subscribers),
    termsVersion: int(r.terms_version),
    id: str(r.id),
    merchantId: str(r.merchant_id),
    onchainPlanId: r.onchain_plan_id === null || r.onchain_plan_id === undefined ? null : dec(r.onchain_plan_id),
    slug: str(r.slug),
    name: str(r.name),
    description: str(r.description),
    features: json<string[]>(r.features, []),
    visibility: str(r.visibility) === "unlisted" ? "unlisted" : "public",
    status: str(r.status) as PlanStatus,
    checkoutUrl: checkoutUrl(str(r.slug)),
    activeSubscribers: int(r.active_subs),
    mrr: dec(r.mrr ?? "0"),
    createTxHash: strOrNull(r.create_tx_hash),
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------- subscriptions

export function subscriptionSelect(sql: Sql) {
  return sql.frag`
    SELECT s.*, p.name AS plan_name, p.slug AS plan_slug,
      m.name AS merchant_name, m.slug AS merchant_slug, m.logo_url AS merchant_logo, m.payout_address AS merchant_payout,
      fj.status AS fail_status, fj.last_error AS fail_error, fj.last_attempt_at AS fail_at, fj.next_attempt_at AS fail_next
    FROM subscriptions s
    JOIN plans p ON p.id = s.plan_id
    JOIN merchants m ON m.id = s.merchant_id
    LEFT JOIN LATERAL (
      SELECT bj.status, bj.last_error, bj.last_attempt_at, bj.next_attempt_at FROM billing_jobs bj
      WHERE bj.subscription_id = s.id AND bj.status IN ('retrying','failed_final') AND bj.period_index = s.payments_count
      ORDER BY bj.updated_at DESC LIMIT 1
    ) fj ON true`;
}

const isCheck = (v: unknown): v is CollectionCheck => typeof v === "string" && (COLLECTION_CHECK as readonly string[]).includes(v);

export function toSubscriptionDTO(r: R): SubscriptionDTO {
  const amount = big(r.amount);
  const introAmount = big(r.intro_amount);
  const introPeriods = int(r.intro_periods);
  const paymentsCount = int(r.payments_count);
  const remainingCap = big(r.remaining_cap);
  const expiresAt = r.expires_at ? new Date(r.expires_at as string) : null;
  const nextBillingAt = new Date(r.next_billing_at as string);
  const status = str(r.status) === "cancelled" ? "cancelled" : "active";
  const billingStatus = (str(r.billing_status) || "ok") as BillingStatus;
  const chainFields = {
    status: status === "cancelled" ? 2 : 1,
    amount,
    introAmount,
    introPeriods,
    paymentsCount,
    remainingCap,
    expiresAt: expiresAt ? BigInt(Math.floor(expiresAt.getTime() / 1000)) : 0n,
    nextBillingAt: BigInt(Math.floor(nextBillingAt.getTime() / 1000)),
  };
  const due = amountDueOf(chainFields);
  const failError = r.fail_error;
  const lastFailure =
    r.fail_status && isCheck(failError)
      ? {
          reason: failError,
          at: isoOrNull(r.fail_at) ?? iso(r.synced_at),
          nextRetryAt: str(r.fail_status) === "retrying" ? isoOrNull(r.fail_next) : null,
        }
      : null;
  return {
    id: str(r.id),
    onchainSubscriptionId: dec(r.onchain_subscription_id),
    plan: { id: str(r.plan_id), name: str(r.plan_name), slug: str(r.plan_slug) },
    merchant: {
      id: str(r.merchant_id),
      name: str(r.merchant_name),
      slug: str(r.merchant_slug),
      logoUrl: strOrNull(r.merchant_logo),
      payoutAddress: strOrNull(r.merchant_payout),
    },
    subscriberAddress: str(r.subscriber_address),
    tokenAddress: str(r.token_address),
    amount: amount.toString(),
    introAmount: introAmount.toString(),
    introPeriods,
    amountDue: due.toString(),
    billingInterval: int(r.billing_interval),
    intervalLabel: intervalLabel(int(r.billing_interval)),
    termsVersion: int(r.terms_version),
    remainingCap: remainingCap.toString(),
    periodsCovered: amount > 0n ? Number(remainingCap / amount) : 0,
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    nextBillingAt: nextBillingAt.toISOString(),
    paymentsCount,
    totalPaid: dec(r.total_paid),
    totalRefunded: dec(r.total_refunded),
    lastPaymentAt: isoOrNull(r.last_payment_at),
    status,
    state: deriveSubscriptionState(chainFields, clock.nowSec(), { billingFailedFinal: billingStatus === "past_due" }),
    billingStatus,
    lastFailure,
    cancelledAt: isoOrNull(r.cancelled_at),
    cancelledBy: (strOrNull(r.cancelled_by) as "subscriber" | "merchant" | "lapsed" | null) ?? null,
    subscribeTxHash: str(r.subscribe_tx_hash),
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------- payments / jobs

export function paymentSelect(sql: Sql) {
  return sql.frag`
    SELECT pay.*, s.onchain_subscription_id, s.subscriber_address, p.name AS plan_name, m.name AS merchant_name,
      m.wallet_address AS merchant_wallet
    FROM payments pay
    JOIN subscriptions s ON s.id = pay.subscription_id
    JOIN plans p ON p.id = s.plan_id
    JOIN merchants m ON m.id = pay.merchant_id`;
}

export function toPaymentDTO(r: R, keeperAddress: string | null = null): PaymentDTO {
  const collector = strOrNull(r.collector);
  const c = collector?.toLowerCase() ?? null;
  const kind: PaymentDTO["collectorKind"] = !c
    ? null
    : c === str(r.merchant_wallet).toLowerCase()
      ? "merchant"
      : keeperAddress && c === keeperAddress.toLowerCase()
        ? "keeper"
        : c === str(r.subscriber_address).toLowerCase()
          ? "subscriber"
          : "unknown";
  const tx = strOrNull(r.transaction_hash);
  const reason = strOrNull(r.failure_reason);
  return {
    id: str(r.id),
    subscriptionId: str(r.subscription_id),
    onchainSubscriptionId: dec(r.onchain_subscription_id),
    planName: str(r.plan_name),
    merchantName: str(r.merchant_name),
    subscriberAddress: str(r.subscriber_address),
    periodIndex: int(r.period_index),
    amount: dec(r.amount),
    status: str(r.status) as PaymentDTO["status"],
    attemptNumber: int(r.attempt_number),
    failureReason: isCheck(reason) ? reason : null,
    transactionHash: tx,
    explorerUrl: tx ? explorerTx(tx) : null,
    collector: c,
    collectorKind: kind,
    billedFor: isoOrNull(r.billed_for),
    paidAt: isoOrNull(r.paid_at),
    createdAt: iso(r.created_at),
  };
}

export function jobSelect(sql: Sql) {
  return sql.frag`
    SELECT j.*, s.onchain_subscription_id, s.subscriber_address, s.amount, s.intro_amount, s.intro_periods, p.name AS plan_name
    FROM billing_jobs j
    JOIN subscriptions s ON s.id = j.subscription_id
    JOIN plans p ON p.id = s.plan_id`;
}

export function toBillingJobDTO(r: R): BillingJobDTO {
  const period = int(r.period_index);
  const amount = period < int(r.intro_periods) ? big(r.intro_amount) : big(r.amount);
  return {
    id: str(r.id),
    subscriptionId: str(r.subscription_id),
    onchainSubscriptionId: dec(r.onchain_subscription_id),
    subscriberAddress: str(r.subscriber_address),
    planName: str(r.plan_name),
    periodIndex: period,
    amount: amount.toString(),
    scheduledAt: iso(r.scheduled_at),
    nextAttemptAt: iso(r.next_attempt_at),
    status: str(r.status) as BillingJobStatus,
    retryCount: int(r.retry_count),
    lastError: strOrNull(r.last_error),
    txHash: strOrNull(r.tx_hash),
    updatedAt: iso(r.updated_at),
  };
}

export function toNotificationDTO(r: R): NotificationDTO {
  return {
    id: str(r.id),
    kind: str(r.kind),
    title: str(r.title),
    body: str(r.body),
    link: strOrNull(r.link),
    read: r.read_at !== null && r.read_at !== undefined,
    createdAt: iso(r.created_at),
  };
}

/** Public (unauthenticated) view of a plan: revenue figures are merchant-private. */
export function toPublicPlanDTO(r: Record<string, unknown>): PlanDTO {
  return { ...toPlanDTO(r), mrr: "0" };
}
