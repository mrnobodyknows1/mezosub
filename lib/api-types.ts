// FROZEN. Shared API contract between route handlers (app/api/**) and the UI.
// Conventions: token amounts are decimal strings in token units (wei, 18 dec for MUSD); timestamps are ISO-8601
// strings; addresses are lowercase 0x strings; on-chain ids are decimal strings. Errors: ApiError with HTTP 4xx/5xx.

import type { CollectionCheck } from "@/lib/chain/config";
import type { DerivedSubscriptionState } from "@/lib/chain/subscription-state";

export type Hex = `0x${string}`;

export interface ApiError {
  error: { code: string; message: string; details?: unknown };
}

// ---------------------------------------------------------------- auth
export interface NonceRequest { address: string }
export interface NonceResponse { nonce: string; message: string } // message = exact text to personal_sign
export interface VerifyRequest { address: string; message: string; signature: Hex }
export interface SessionResponse { address: string | null; merchant: MerchantDTO | null }

// ---------------------------------------------------------------- merchants
export type MerchantChainStatus = "pending" | "active" | "paused" | "suspended";
export interface MerchantDTO {
  id: string; // uuid
  onchainMerchantId: string | null;
  walletAddress: string;
  payoutAddress: string | null;
  chainStatus: MerchantChainStatus;
  keeperEnabled: boolean;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  website: string | null;
  supportEmail: string | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  notifyOnPayment: boolean;
  notifyOnFailure: boolean;
  metadataURI: string; // pass to registerMerchant()
  registerTxHash: string | null;
  createdAt: string;
}
export interface PublicMerchantDTO {
  id: string;
  name: string;
  slug: string;
  description: string;
  logoUrl: string | null;
  website: string | null;
  supportEmail: string | null;
  walletAddress: string;
  payoutAddress: string | null;
  chainStatus: MerchantChainStatus;
}
/** POST /api/merchants — creates the off-chain profile (status pending) before registerMerchant(). */
export interface CreateMerchantRequest {
  name: string; // 2..80
  description?: string; // ..500
  logoUrl?: string | null; // https URL or null
  website?: string | null;
  supportEmail?: string | null;
}
export type UpdateMerchantRequest = Partial<CreateMerchantRequest> & {
  webhookUrl?: string | null; // https only
  notifyOnPayment?: boolean;
  notifyOnFailure?: boolean;
};
export interface RotateWebhookSecretResponse { secret: string } // shown once
/** Any tx-confirm endpoint: the server fetches the receipt, verifies status + expected log + sender, then syncs. */
export interface ConfirmTxRequest { txHash: Hex }

// ---------------------------------------------------------------- plans
export type PlanStatus = "draft" | "active" | "paused" | "archived";
export interface PlanTerms {
  tokenAddress: string;
  tokenSymbol: string; // "MUSD"
  tokenDecimals: number; // 18
  price: string; // per period
  billingInterval: number; // seconds
  intervalLabel: string; // "Monthly" | "Every 5 minutes (testnet demo)" | "Every N days"
  trialSeconds: number;
  introPrice: string; // "0" when none
  introPeriods: number;
  maxSubscribers: number; // 0 = unlimited
  termsVersion: number;
}
export interface PlanDTO extends PlanTerms {
  id: string;
  merchantId: string;
  onchainPlanId: string | null;
  slug: string;
  name: string;
  description: string;
  features: string[];
  visibility: "public" | "unlisted";
  status: PlanStatus;
  checkoutUrl: string; // absolute, NEXT_PUBLIC_APP_URL + /subscribe/<slug>
  activeSubscribers: number;
  mrr: string; // monthly-normalised recurring revenue from active subs on this plan
  createTxHash: string | null;
  createdAt: string;
}
/** POST /api/plans — draft row. Terms here must equal the createPlan() params the UI then sends. */
export interface CreatePlanRequest {
  name: string; // 2..80
  description?: string; // ..1000
  features?: string[]; // ≤8, each ≤120
  slug?: string; // optional custom; [a-z0-9-]{3,60}; default from name
  visibility?: "public" | "unlisted";
  price: string; // human MUSD, e.g. "5" or "4.99"
  billingInterval: number; // seconds; must be a BILLING_INTERVALS value
  trialDays?: number; // 0..365 (demo plans may pass trialSeconds instead)
  trialSeconds?: number;
  introPrice?: string; // human MUSD; requires introPeriods > 0
  introPeriods?: number; // 0..24
  maxSubscribers?: number; // 0 = unlimited
}
/** Metadata only. Term changes go through updatePlan() on-chain then POST /api/plans/:id/confirm. */
export interface UpdatePlanMetaRequest {
  name?: string;
  description?: string;
  features?: string[];
  visibility?: "public" | "unlisted";
}
/** GET /api/plans/:id/chain-params — exact args for createPlan/updatePlan (wei strings). */
export interface PlanChainParams {
  token: string;
  amount: string;
  interval: number;
  trialPeriod: number;
  introAmount: string;
  introPeriods: number;
  maxSubscribers: number;
}

// ---------------------------------------------------------------- public checkout
export interface CheckoutDTO {
  plan: PlanDTO;
  merchant: PublicMerchantDTO;
  managerAddress: string;
  chainId: number;
  /** Live from chain at request time; the UI must pass termsVersion as expectedTermsVersion. */
  live: { planStatus: PlanStatus; termsVersion: number; activeSubscribers: number; acceptingSubscribers: boolean; reason: string | null };
  firstCharge: { amount: string; at: string }; // at = now (no trial) or now + trial
  secondCharge: { amount: string; at: string };
  /** Suggested per-subscription authorization: 12 periods (or 52 for weekly, 4 quarterly, 2 yearly, 12 demo). */
  suggestedSpendCap: string;
  suggestedPeriods: number;
}

// ---------------------------------------------------------------- subscriptions
export type BillingStatus = "ok" | "retrying" | "past_due";
export interface SubscriptionDTO {
  id: string;
  onchainSubscriptionId: string;
  plan: { id: string; name: string; slug: string };
  merchant: { id: string; name: string; slug: string; logoUrl: string | null; payoutAddress: string | null };
  subscriberAddress: string;
  tokenAddress: string;
  amount: string;
  introAmount: string;
  introPeriods: number;
  amountDue: string; // next charge amount
  billingInterval: number;
  intervalLabel: string;
  termsVersion: number;
  remainingCap: string;
  periodsCovered: number; // floor(remainingCap / amount) — how many more charges the authorization allows
  expiresAt: string | null;
  nextBillingAt: string;
  paymentsCount: number;
  totalPaid: string;
  totalRefunded: string;
  lastPaymentAt: string | null;
  status: "active" | "cancelled";
  state: DerivedSubscriptionState;
  billingStatus: BillingStatus;
  lastFailure: { reason: CollectionCheck; at: string; nextRetryAt: string | null } | null;
  cancelledAt: string | null;
  cancelledBy: "subscriber" | "merchant" | "lapsed" | null;
  subscribeTxHash: string;
  createdAt: string;
}
export interface SubscriptionDetailDTO extends SubscriptionDTO {
  payments: PaymentDTO[];
  jobs: BillingJobDTO[];
}

// ---------------------------------------------------------------- payments & billing
export interface PaymentDTO {
  id: string;
  subscriptionId: string;
  onchainSubscriptionId: string;
  planName: string;
  merchantName: string;
  subscriberAddress: string;
  periodIndex: number;
  amount: string;
  status: "succeeded" | "failed" | "refunded";
  attemptNumber: number;
  failureReason: CollectionCheck | null;
  transactionHash: string | null;
  explorerUrl: string | null;
  collector: string | null;
  collectorKind: "merchant" | "keeper" | "subscriber" | "unknown" | null;
  billedFor: string | null;
  paidAt: string | null;
  createdAt: string;
}
export type BillingJobStatus = "scheduled" | "processing" | "submitted" | "retrying" | "succeeded" | "failed_final" | "skipped" | "cancelled";
export interface BillingJobDTO {
  id: string;
  subscriptionId: string;
  onchainSubscriptionId: string;
  subscriberAddress: string;
  planName: string;
  periodIndex: number;
  amount: string;
  scheduledAt: string;
  nextAttemptAt: string;
  status: BillingJobStatus;
  retryCount: number;
  lastError: string | null;
  txHash: string | null;
  updatedAt: string;
}
export interface BillingOverviewDTO {
  upcoming: BillingJobDTO[]; // scheduled, next 7 days (or next 20 jobs)
  due: SubscriptionDTO[]; // state === "due" right now — show "Collect due payment"
  failing: BillingJobDTO[]; // retrying | failed_final
  recent: BillingJobDTO[]; // last 20 finished
  keeper: { address: string | null; enabledForMerchant: boolean; lastRunAt: string | null; healthy: boolean };
  retryPolicy: { delaysSeconds: number[]; demoMode: boolean };
}

// ---------------------------------------------------------------- dashboards
export interface MerchantOverviewDTO {
  totalRevenue: string; // sum succeeded payments - refunds
  mrr: string; // Σ active subs amount × perMonth(interval)
  activeSubscribers: number;
  newSubscribers30d: number;
  cancelled30d: number;
  failedPayments30d: number;
  upcomingCollections7d: { count: number; amount: string };
  revenueSeries: { date: string; amount: string }[]; // daily, last 30 days, UTC dates
  recentPayments: PaymentDTO[]; // last 10
  reconciliation: { lastIndexedBlock: string | null; chainHead: string | null; lagBlocks: number | null; mismatches: number };
}
export interface SubscriberDashboardDTO {
  subscriptions: SubscriptionDTO[];
  payments: PaymentDTO[]; // last 50 across all subscriptions
  allowance: { tokenAddress: string; spender: string; current: string; committed: string }; // committed = Σ remainingCap of active subs
}
export interface Paginated<T> { items: T[]; total: number; page: number; pageSize: number }

// ---------------------------------------------------------------- misc
export interface NotificationDTO {
  id: string;
  kind: string;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
}
export interface HealthResponse {
  ok: boolean;
  chainId: number | null;
  head: string | null;
  deployed: boolean;
  db: "postgres" | "pglite";
  indexer: { lastBlock: string | null; lagBlocks: number | null; updatedAt: string | null };
  worker: { lastRunAt: string | null; healthy: boolean };
  musd: { address: string; symbol: string | null; decimals: number | null };
}
/** Payload sent to merchant webhooks; header X-MezoSub-Signature: t=<unix>,v1=<hex hmac sha256 of `${t}.${body}`>. */
export interface WebhookPayload {
  id: string;
  type: string;
  createdAt: string;
  data: Record<string, unknown>;
}
