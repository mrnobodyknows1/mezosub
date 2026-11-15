// Event application + indexer loop.
//
// `applyEvent` is THE single code path that turns a confirmed MezoSub log into DB state. It is used by the
// worker's indexer AND by the tx-confirm API endpoints (so the UI updates without waiting for the worker).
// Idempotency: chain_events (tx_hash, log_index) is unique and `processed_at` is set in the same DB transaction
// as the state change, so re-applying a log is a no-op.

import type { Address, Hex } from "viem";
import {
  CHAIN_MERCHANT_STATUS,
  CHAIN_PLAN_STATUS,
  COLLECTION_CHECK,
  contracts,
  isDeployed,
  type CollectionCheck,
} from "@/lib/chain/config";
import { formatMusd } from "@/lib/money";
import type { Sql } from "./db";
import { big, int, str } from "./db/rows";
import { argsToJson, decodeLog, type ChainAdapter, type ChainSubscription, type DecodedLog } from "./chain";
import { clock } from "./clock";
import { env } from "./env";
import { audit, enqueueWebhook, links, notify } from "./notify";
import { uniqueSlug } from "./slug";

const lc = (a: unknown) => String(a ?? "").toLowerCase();
const s = (v: unknown) => (typeof v === "bigint" ? v.toString() : String(v ?? "0"));
const toDate = (sec: unknown): Date | null => {
  const n = Number(sec ?? 0);
  return n === 0 ? null : new Date(n * 1000);
};

export interface ApplyContext {
  chain: ChainAdapter;
  /** Plan confirm endpoint: link a PlanCreated event to this draft row (already verified by the caller). */
  linkDraftPlanId?: string;
}

// ---------------------------------------------------------------- shared upserts

export async function ensureUser(tx: Sql, address: string): Promise<string> {
  const a = address.toLowerCase();
  const [row] = await tx<{ id: string }>`
    INSERT INTO users (wallet_address) VALUES (${a})
    ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address
    RETURNING id`;
  return row.id;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Link a registration to a merchant row:
 *  1. row already linked to onchainId → update;
 *  2. metadataURI `mezosub:merchant:<uuid>` AND that row's wallet == event owner → link it;
 *  3. owner's own unlinked pending row → link it (owner match is the security condition);
 *  4. otherwise create a placeholder merchant ("Merchant #id").
 */
async function linkOrCreateMerchant(
  tx: Sql,
  m: { onchainId: bigint; owner: string; payout: string; metadataURI: string; status: string; keeperEnabled: boolean; txHash: string | null },
): Promise<string> {
  const owner = m.owner.toLowerCase();
  const [existing] = await tx<{ id: string }>`SELECT id FROM merchants WHERE onchain_merchant_id = ${m.onchainId}`;
  if (existing) return existing.id;

  const match = /^mezosub:merchant:(.+)$/.exec(m.metadataURI || "");
  if (match && UUID_RE.test(match[1])) {
    const [linked] = await tx<{ id: string }>`
      UPDATE merchants SET onchain_merchant_id = ${m.onchainId}, payout_address = ${m.payout.toLowerCase()},
        chain_status = ${m.status}, keeper_enabled = ${m.keeperEnabled}, register_tx_hash = COALESCE(register_tx_hash, ${m.txHash}),
        updated_at = ${clock.now()}
      WHERE id = ${match[1]} AND wallet_address = ${owner} AND onchain_merchant_id IS NULL
      RETURNING id`;
    if (linked) return linked.id;
  }
  const [own] = await tx<{ id: string }>`
    UPDATE merchants SET onchain_merchant_id = ${m.onchainId}, payout_address = ${m.payout.toLowerCase()},
      chain_status = ${m.status}, keeper_enabled = ${m.keeperEnabled}, register_tx_hash = COALESCE(register_tx_hash, ${m.txHash}),
      updated_at = ${clock.now()}
    WHERE wallet_address = ${owner} AND onchain_merchant_id IS NULL
    RETURNING id`;
  if (own) return own.id;

  const userId = await ensureUser(tx, owner);
  const slug = await uniqueSlug(tx, "merchants", `merchant-${m.onchainId}`);
  const [created] = await tx<{ id: string }>`
    INSERT INTO merchants (owner_user_id, wallet_address, onchain_merchant_id, payout_address, chain_status, keeper_enabled,
                           name, slug, register_tx_hash)
    VALUES (${userId}, ${owner}, ${m.onchainId}, ${m.payout.toLowerCase()}, ${m.status}, ${m.keeperEnabled},
            ${`Merchant #${m.onchainId}`}, ${slug}, ${m.txHash})
    ON CONFLICT (wallet_address) DO UPDATE SET onchain_merchant_id = EXCLUDED.onchain_merchant_id
    RETURNING id`;
  return created.id;
}

async function ensureMerchantRow(tx: Sql, chain: ChainAdapter, onchainId: bigint): Promise<string | null> {
  const [row] = await tx<{ id: string }>`SELECT id FROM merchants WHERE onchain_merchant_id = ${onchainId}`;
  if (row) return row.id;
  try {
    const m = await chain.getMerchant(onchainId);
    if (m.status === 0) return null;
    return await linkOrCreateMerchant(tx, {
      onchainId,
      owner: m.owner,
      payout: m.payout,
      metadataURI: m.metadataURI,
      status: CHAIN_MERCHANT_STATUS[m.status] ?? "active",
      keeperEnabled: m.keeperEnabled,
      txHash: null,
    });
  } catch (e) {
    if (isNotFoundRevert(e)) return null;
    throw e; // RPC trouble: abort this pass so the event is retried, never silently dropped
  }
}

// ---------------------------------------------------------------- error classification

/** The contract said the id does not exist (vs. the RPC failing). */
export function isNotFoundRevert(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
    const name = (c as { data?: { errorName?: string } }).data?.errorName;
    if (name && /NotFound$/.test(name)) return true;
    const msg = (c as Error).message ?? "";
    if (/\b(SubscriptionNotFound|PlanNotFound|MerchantNotFound)\b/.test(msg)) return true;
  }
  return false;
}

/** Network / RPC / DB-connection trouble: retry the whole pass later instead of skipping the event. */
export function isTransientError(e: unknown): boolean {
  for (let c: unknown = e, i = 0; c && i < 6; c = (c as { cause?: unknown }).cause, i++) {
    const err = c as { name?: string; code?: unknown; message?: string };
    if (err.name && /^(HttpRequestError|TimeoutError|RpcRequestError|WebSocketRequestError|SocketClosedError|AbortError)$/.test(err.name)) return true;
    const code = typeof err.code === "string" ? err.code : "";
    if (/^(08|53|57P)/.test(code) || /^CONNECTION_|^ECONN|^ETIMEDOUT|^EPIPE/.test(code)) return true;
    if (/fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|timed out/i.test(err.message ?? "")) return true;
  }
  return false;
}

interface PlanTermsInput {
  token: string;
  amount: bigint;
  interval: number;
  trialPeriod: number;
  introAmount: bigint;
  introPeriods: number;
  maxSubscribers: number;
}

async function insertMinimalPlan(
  tx: Sql,
  merchantRowId: string,
  onchainPlanId: bigint,
  t: PlanTermsInput,
  termsVersion: number,
  status: string,
  txHash: string | null,
): Promise<string> {
  const slug = await uniqueSlug(tx, "plans", `plan-${onchainPlanId}`);
  const [row] = await tx<{ id: string }>`
    INSERT INTO plans (merchant_id, onchain_plan_id, slug, name, token_address, price, billing_interval, trial_seconds,
                       intro_price, intro_periods, max_subscribers, terms_version, status, create_tx_hash, visibility)
    VALUES (${merchantRowId}, ${onchainPlanId}, ${slug}, ${`Plan #${onchainPlanId}`}, ${t.token.toLowerCase()}, ${t.amount}::numeric,
            ${t.interval}, ${t.trialPeriod}, ${t.introAmount}::numeric, ${t.introPeriods}, ${t.maxSubscribers}, ${termsVersion},
            ${status}, ${txHash}, 'unlisted')
    ON CONFLICT (onchain_plan_id) DO UPDATE SET updated_at = plans.updated_at
    RETURNING id`;
  return row.id;
}

async function ensurePlanRow(
  tx: Sql,
  chain: ChainAdapter,
  onchainPlanId: bigint,
  fallback?: { merchantOnchainId: bigint; amount: bigint; interval: number; termsVersion: number },
): Promise<{ id: string; merchantId: string } | null> {
  const [row] = await tx<{ id: string; merchant_id: string }>`SELECT id, merchant_id FROM plans WHERE onchain_plan_id = ${onchainPlanId}`;
  if (row) return { id: row.id, merchantId: row.merchant_id };
  let terms: PlanTermsInput;
  let merchantOnchainId: bigint;
  let termsVersion = 1;
  let status = "active";
  try {
    const p = await chain.getPlan(onchainPlanId);
    merchantOnchainId = p.merchantId;
    terms = {
      token: p.token,
      amount: p.amount,
      interval: p.interval,
      trialPeriod: p.trialPeriod,
      introAmount: p.introAmount,
      introPeriods: p.introPeriods,
      maxSubscribers: p.maxSubscribers,
    };
    termsVersion = p.termsVersion;
    status = CHAIN_PLAN_STATUS[p.status] === "none" ? "active" : (CHAIN_PLAN_STATUS[p.status] ?? "active");
  } catch {
    if (!fallback) return null;
    merchantOnchainId = fallback.merchantOnchainId;
    terms = {
      token: contracts.musd,
      amount: fallback.amount,
      interval: fallback.interval,
      trialPeriod: 0,
      introAmount: 0n,
      introPeriods: 0,
      maxSubscribers: 0,
    };
    termsVersion = fallback.termsVersion;
  }
  const merchantRowId = await ensureMerchantRow(tx, chain, merchantOnchainId);
  if (!merchantRowId) return null;
  const id = await insertMinimalPlan(tx, merchantRowId, onchainPlanId, terms, termsVersion, status, null);
  return { id, merchantId: merchantRowId };
}

interface SubRow {
  id: string;
  merchant_id: string;
  plan_id: string;
  subscriber_address: string;
  status: string;
  payments_count: number;
  billing_interval: number;
}

async function subRow(tx: Sql, onchainId: bigint): Promise<SubRow | null> {
  const [r] = await tx<SubRow>`
    SELECT id, merchant_id, plan_id, subscriber_address, status, payments_count, billing_interval
    FROM subscriptions WHERE onchain_subscription_id = ${onchainId}`;
  return r ? { ...r, payments_count: int(r.payments_count), billing_interval: int(r.billing_interval) } : null;
}

/** Create a subscription row from a full chain read (used when an event references an unknown subscription). */
async function insertSubFromChain(tx: Sql, chain: ChainAdapter, onchainId: bigint, cs: ChainSubscription, txHash: string): Promise<SubRow | null> {
  const plan = await ensurePlanRow(tx, chain, cs.planId);
  if (!plan) return null;
  await tx`
    INSERT INTO subscriptions (onchain_subscription_id, plan_id, merchant_id, subscriber_address, token_address, amount, intro_amount,
      intro_periods, billing_interval, terms_version, remaining_cap, expires_at, next_billing_at, payments_count, total_paid,
      total_refunded, status, last_payment_at, cancelled_at, subscribe_tx_hash, created_at)
    VALUES (${onchainId}, ${plan.id}, ${plan.merchantId}, ${lc(cs.subscriber)}, ${lc(cs.token)}, ${cs.amount}::numeric,
      ${cs.introAmount}::numeric, ${cs.introPeriods}, ${cs.interval}, ${cs.termsVersion}, ${cs.remainingCap}::numeric,
      ${toDate(cs.expiresAt)}, ${toDate(cs.nextBillingAt) ?? clock.now()}, ${cs.paymentsCount}, ${cs.totalPaid}::numeric,
      ${cs.totalRefunded}::numeric, ${cs.status === 2 ? "cancelled" : "active"}, ${toDate(cs.lastPaymentAt)}, ${toDate(cs.cancelledAt)},
      ${txHash}, ${toDate(cs.createdAt) ?? clock.now()})
    ON CONFLICT (onchain_subscription_id) DO NOTHING`;
  return subRow(tx, onchainId);
}

async function ensureSubRow(tx: Sql, chain: ChainAdapter, onchainId: bigint, txHash: string): Promise<SubRow | null> {
  const r = await subRow(tx, onchainId);
  if (r) return r;
  try {
    const cs = await chain.getSubscription(onchainId);
    if (cs.status === 0) return null;
    return await insertSubFromChain(tx, chain, onchainId, cs, txHash);
  } catch (e) {
    if (isNotFoundRevert(e)) return null;
    throw e; // RPC trouble: abort this pass so the event is retried, never silently dropped
  }
}

async function merchantInfo(tx: Sql, merchantId: string) {
  const [m] = await tx<{ id: string; name: string; wallet_address: string; notify_on_payment: boolean; notify_on_failure: boolean }>`
    SELECT id, name, wallet_address, notify_on_payment, notify_on_failure FROM merchants WHERE id = ${merchantId}`;
  return m;
}

async function planName(tx: Sql, planId: string): Promise<string> {
  const [p] = await tx<{ name: string }>`SELECT name FROM plans WHERE id = ${planId}`;
  return p?.name ?? "subscription";
}

async function reviveSkippedForMerchant(tx: Sql, onchainMerchantId: bigint) {
  await tx`
    UPDATE billing_jobs j SET status = 'scheduled', next_attempt_at = ${clock.now()}, updated_at = ${clock.now()}
    FROM subscriptions s, merchants m
    WHERE j.subscription_id = s.id AND s.merchant_id = m.id AND m.onchain_merchant_id = ${onchainMerchantId}
      AND s.status = 'active' AND j.status = 'skipped'`;
}

// ---------------------------------------------------------------- event handlers

type Handler = (tx: Sql, log: DecodedLog, blockTime: Date, ctx: ApplyContext) => Promise<void>;

const handlers: Record<string, Handler> = {
  // ---------------- registry
  async MerchantRegistered(tx, log) {
    const a = log.args;
    await linkOrCreateMerchant(tx, {
      onchainId: big(a.merchantId),
      owner: String(a.owner),
      payout: String(a.payout),
      metadataURI: String(a.metadataURI ?? ""),
      status: "active",
      keeperEnabled: true,
      txHash: log.txHash,
    });
  },
  async MerchantPayoutChanged(tx, log) {
    await tx`UPDATE merchants SET payout_address = ${lc(log.args.payout)}, updated_at = ${clock.now()}
             WHERE onchain_merchant_id = ${big(log.args.merchantId)}`;
  },
  async MerchantMetadataChanged(tx, log) {
    await audit(tx, "indexer", "merchant.metadata_changed", s(log.args.merchantId), { metadataURI: String(log.args.metadataURI) });
  },
  async MerchantStatusChanged(tx, log) {
    const status = CHAIN_MERCHANT_STATUS[Number(log.args.status)] ?? "active";
    await tx`UPDATE merchants SET chain_status = ${status === "none" ? "pending" : status}, updated_at = ${clock.now()}
             WHERE onchain_merchant_id = ${big(log.args.merchantId)}`;
    await reviveSkippedForMerchant(tx, big(log.args.merchantId));
  },
  async MerchantKeeperAccessChanged(tx, log) {
    await tx`UPDATE merchants SET keeper_enabled = ${Boolean(log.args.enabled)}, updated_at = ${clock.now()}
             WHERE onchain_merchant_id = ${big(log.args.merchantId)}`;
    await reviveSkippedForMerchant(tx, big(log.args.merchantId));
  },
  async MerchantOwnershipTransferred(tx, log) {
    const id = big(log.args.merchantId);
    const newOwner = lc(log.args.newOwner);
    // A pending (never registered) profile of the new owner would collide with the unique wallet index.
    const [clash] = await tx<{ id: string; onchain_merchant_id: string | null }>`
      SELECT id, onchain_merchant_id FROM merchants WHERE wallet_address = ${newOwner} AND (onchain_merchant_id IS NULL OR onchain_merchant_id <> ${id})`;
    if (clash) {
      const [{ n }] = await tx<{ n: number }>`SELECT count(*)::int AS n FROM plans WHERE merchant_id = ${clash.id}`;
      if (clash.onchain_merchant_id === null && int(n) === 0) {
        // The pending profile never reached the chain and has no plans; only webhook rows can point at it.
        await tx`DELETE FROM webhook_events WHERE merchant_id = ${clash.id}`;
        await tx`DELETE FROM merchants WHERE id = ${clash.id}`;
      }
      else {
        await audit(tx, "indexer", "merchant.ownership_conflict", s(id), { newOwner });
        return;
      }
    }
    const userId = await ensureUser(tx, newOwner);
    await tx`UPDATE merchants SET wallet_address = ${newOwner}, owner_user_id = ${userId}, updated_at = ${clock.now()}
             WHERE onchain_merchant_id = ${id}`;
  },

  // ---------------- plans
  async TokenAllowed(tx, log) {
    await audit(tx, "indexer", "token.allowed", lc(log.args.token), { allowed: Boolean(log.args.allowed) });
  },
  async PlanCreated(tx, log, _bt, ctx) {
    const a = log.args;
    const planId = big(a.planId);
    const terms: PlanTermsInput = {
      token: String(a.token),
      amount: big(a.amount),
      interval: Number(a.interval),
      trialPeriod: Number(a.trialPeriod),
      introAmount: big(a.introAmount),
      introPeriods: Number(a.introPeriods),
      maxSubscribers: Number(a.maxSubscribers),
    };
    const [existing] = await tx<{ id: string }>`SELECT id FROM plans WHERE onchain_plan_id = ${planId}`;
    if (existing) return;
    const merchantRowId = await ensureMerchantRow(tx, ctx.chain, big(a.merchantId));
    if (!merchantRowId) {
      await audit(tx, "indexer", "plan.orphan", planId.toString(), { merchantId: s(a.merchantId) });
      return;
    }
    const setTerms = tx.frag`onchain_plan_id = ${planId}, token_address = ${lc(terms.token)}, price = ${terms.amount}::numeric,
      billing_interval = ${terms.interval}, trial_seconds = ${terms.trialPeriod}, intro_price = ${terms.introAmount}::numeric,
      intro_periods = ${terms.introPeriods}, max_subscribers = ${terms.maxSubscribers}, terms_version = 1, status = 'active',
      create_tx_hash = ${log.txHash}, updated_at = ${clock.now()}`;
    if (ctx.linkDraftPlanId) {
      const [linked] = await tx<{ id: string }>`
        UPDATE plans SET ${setTerms} WHERE id = ${ctx.linkDraftPlanId} AND merchant_id = ${merchantRowId} AND onchain_plan_id IS NULL
        RETURNING id`;
      if (linked) return;
    }
    // Indexer path: auto-link the oldest unlinked draft of the same merchant with identical terms.
    const [draft] = await tx<{ id: string }>`
      SELECT id FROM plans
      WHERE merchant_id = ${merchantRowId} AND onchain_plan_id IS NULL AND status = 'draft'
        AND lower(token_address) = ${lc(terms.token)} AND price = ${terms.amount}::numeric AND billing_interval = ${terms.interval}
        AND trial_seconds = ${terms.trialPeriod} AND intro_price = ${terms.introAmount}::numeric AND intro_periods = ${terms.introPeriods}
        AND max_subscribers = ${terms.maxSubscribers}
      ORDER BY created_at ASC LIMIT 1`;
    if (draft) {
      await tx`UPDATE plans SET ${setTerms} WHERE id = ${draft.id}`;
      return;
    }
    await insertMinimalPlan(tx, merchantRowId, planId, terms, 1, "active", log.txHash);
  },
  async PlanUpdated(tx, log) {
    const a = log.args;
    await tx`UPDATE plans SET price = ${big(a.amount)}::numeric, billing_interval = ${Number(a.interval)},
               trial_seconds = ${Number(a.trialPeriod)}, intro_price = ${big(a.introAmount)}::numeric,
               intro_periods = ${Number(a.introPeriods)}, max_subscribers = ${Number(a.maxSubscribers)},
               terms_version = GREATEST(terms_version, ${Number(a.termsVersion)}::int), updated_at = ${clock.now()}
             WHERE onchain_plan_id = ${big(a.planId)}`;
  },
  async PlanStatusChanged(tx, log) {
    const status = CHAIN_PLAN_STATUS[Number(log.args.status)] ?? "active";
    if (status === "none") return;
    await tx`UPDATE plans SET status = ${status}, updated_at = ${clock.now()} WHERE onchain_plan_id = ${big(log.args.planId)}`;
  },

  // ---------------- subscriptions
  async Subscribed(tx, log, blockTime, ctx) {
    const a = log.args;
    const subId = big(a.subscriptionId);
    if (await subRow(tx, subId)) return;
    const plan = await ensurePlanRow(tx, ctx.chain, big(a.planId), {
      merchantOnchainId: big(a.merchantId),
      amount: big(a.amount),
      interval: Number(a.interval),
      termsVersion: Number(a.termsVersion),
    });
    if (!plan) {
      await audit(tx, "indexer", "subscription.orphan", subId.toString(), { planId: s(a.planId) });
      return;
    }
    // Intro terms are not in the event: take them from the plan row when it is at the same terms version.
    const [p] = await tx<{ token_address: string; intro_price: string; intro_periods: number; terms_version: number }>`
      SELECT token_address, intro_price, intro_periods, terms_version FROM plans WHERE id = ${plan.id}`;
    const sameVersion = p && int(p.terms_version) === Number(a.termsVersion);
    const subscriber = lc(a.subscriber);
    await tx`
      INSERT INTO subscriptions (onchain_subscription_id, plan_id, merchant_id, subscriber_address, token_address, amount,
        intro_amount, intro_periods, billing_interval, terms_version, remaining_cap, expires_at, next_billing_at, subscribe_tx_hash, created_at)
      VALUES (${subId}, ${plan.id}, ${plan.merchantId}, ${subscriber}, ${lc(p?.token_address ?? contracts.musd)}, ${big(a.amount)}::numeric,
        ${sameVersion ? big(p.intro_price) : 0n}::numeric, ${sameVersion ? int(p.intro_periods) : 0}, ${Number(a.interval)},
        ${Number(a.termsVersion)}, ${big(a.spendCap)}::numeric, ${toDate(a.expiresAt)}, ${toDate(a.nextBillingAt) ?? blockTime},
        ${log.txHash}, ${blockTime})
      ON CONFLICT (onchain_subscription_id) DO NOTHING`;
    const sub = await subRow(tx, subId);
    if (!sub) return;
    const m = await merchantInfo(tx, plan.merchantId);
    const name = await planName(tx, plan.id);
    await notify(tx, {
      address: m.wallet_address,
      kind: "new_subscriber",
      title: "New subscriber",
      body: `${short(subscriber)} subscribed to ${name}.`,
      link: links.merchantSubscription(sub.id),
      dedupeKey: `new_subscriber:${subId}`,
    });
    await enqueueWebhook(tx, {
      merchantId: plan.merchantId,
      type: "subscription.created",
      dedupeKey: `subscription.created:${subId}`,
      data: {
        subscriptionId: subId.toString(),
        planId: s(a.planId),
        subscriber,
        amount: s(a.amount),
        interval: Number(a.interval),
        termsVersion: Number(a.termsVersion),
        spendCap: s(a.spendCap),
        expiresAt: s(a.expiresAt),
        nextBillingAt: s(a.nextBillingAt),
        txHash: log.txHash,
      },
    });
  },

  async PaymentCollected(tx, log, blockTime, ctx) {
    const a = log.args;
    const subId = big(a.subscriptionId);
    const sub = await ensureSubRow(tx, ctx.chain, subId, log.txHash);
    if (!sub) {
      await audit(tx, "indexer", "payment.orphan", subId.toString(), { txHash: log.txHash });
      return;
    }
    const period = Number(a.periodIndex);
    const amount = big(a.amount);
    const inserted = await tx<{ id: string }>`
      INSERT INTO payments (subscription_id, merchant_id, period_index, amount, status, attempt_number, transaction_hash, log_index,
        block_number, collector, payout_address, billed_for, paid_at, created_at)
      VALUES (${sub.id}, ${sub.merchant_id}, ${period}, ${amount}::numeric, 'succeeded',
        (SELECT count(*)::int + 1 FROM payments WHERE subscription_id = ${sub.id} AND period_index = ${period} AND status = 'failed'),
        ${log.txHash}, ${log.logIndex}, ${log.blockNumber}, ${lc(a.collector)}, ${lc(a.payout)}, ${toDate(a.billedFor)}, ${blockTime}, ${clock.now()})
      ON CONFLICT DO NOTHING
      RETURNING id`;
    if (inserted.length === 0) return; // this period was already recorded
    await tx`
      UPDATE subscriptions SET
        payments_count = GREATEST(payments_count, ${period + 1}::int),
        next_billing_at = CASE WHEN ${period + 1}::int >= payments_count THEN ${toDate(a.nextBillingAt) ?? blockTime}::timestamptz ELSE next_billing_at END,
        -- A chain re-read (reconcile / confirm) may already include this period: payments_count > period then.
        remaining_cap = CASE WHEN payments_count <= ${period}::int THEN GREATEST(remaining_cap - ${amount}::numeric, 0) ELSE remaining_cap END,
        total_paid = CASE WHEN payments_count <= ${period}::int THEN total_paid + ${amount}::numeric ELSE total_paid END,
        last_payment_at = GREATEST(COALESCE(last_payment_at, ${blockTime}::timestamptz), ${blockTime}::timestamptz),
        billing_status = 'ok', synced_at = ${clock.now()}
      WHERE id = ${sub.id}`;
    await tx`
      INSERT INTO billing_jobs (subscription_id, period_index, scheduled_at, next_attempt_at, status, tx_hash, updated_at)
      VALUES (${sub.id}, ${period}, ${toDate(a.billedFor) ?? blockTime}, ${blockTime}, 'succeeded', ${log.txHash}, ${clock.now()})
      ON CONFLICT (subscription_id, period_index) DO UPDATE SET status = 'succeeded', tx_hash = COALESCE(billing_jobs.tx_hash, EXCLUDED.tx_hash),
        locked_by = NULL, locked_until = NULL, last_error = NULL, updated_at = EXCLUDED.updated_at`;
    const m = await merchantInfo(tx, sub.merchant_id);
    const name = await planName(tx, sub.plan_id);
    const amt = formatMusd(amount, { symbol: true });
    await notify(tx, {
      address: sub.subscriber_address,
      kind: "payment_succeeded",
      title: "Payment sent",
      body: `${amt} paid to ${m.name} for ${name}.`,
      link: links.subscriberSubscription(sub.id),
      dedupeKey: `payment_succeeded:sub:${log.txHash}:${log.logIndex}`,
    });
    if (m.notify_on_payment) {
      await notify(tx, {
        address: m.wallet_address,
        kind: "payment_succeeded",
        title: "Payment received",
        body: `${amt} from ${short(sub.subscriber_address)} for ${name}.`,
        link: links.merchantSubscription(sub.id),
        dedupeKey: `payment_succeeded:merchant:${log.txHash}:${log.logIndex}`,
      });
    }
    await enqueueWebhook(tx, {
      merchantId: sub.merchant_id,
      type: "payment.succeeded",
      dedupeKey: `payment.succeeded:${log.txHash}:${log.logIndex}`,
      data: {
        subscriptionId: subId.toString(),
        subscriber: sub.subscriber_address,
        amount: amount.toString(),
        token: lc(a.token),
        payout: lc(a.payout),
        periodIndex: period,
        billedFor: s(a.billedFor),
        nextBillingAt: s(a.nextBillingAt),
        collector: lc(a.collector),
        txHash: log.txHash,
      },
    });
  },

  async PaymentFailed(tx, log, blockTime, ctx) {
    const a = log.args;
    const sub = await ensureSubRow(tx, ctx.chain, big(a.subscriptionId), log.txHash);
    if (!sub) return;
    const reason: CollectionCheck = COLLECTION_CHECK[Number(a.reason)] ?? "transfer_failed";
    await tx`
      INSERT INTO payments (subscription_id, merchant_id, period_index, amount, status, attempt_number, transaction_hash, log_index,
        block_number, collector, failure_reason, created_at)
      VALUES (${sub.id}, ${sub.merchant_id}, ${Number(a.periodIndex)}, ${big(a.amount)}::numeric, 'failed',
        (SELECT count(*)::int + 1 FROM payments WHERE subscription_id = ${sub.id} AND period_index = ${Number(a.periodIndex)} AND status = 'failed'),
        ${log.txHash}, ${log.logIndex}, ${log.blockNumber}, ${lc(a.collector)}, ${reason}, ${blockTime})
      ON CONFLICT DO NOTHING`;
  },

  async CollectionSkipped(tx, log) {
    await audit(tx, "indexer", "collection.skipped", s(log.args.subscriptionId), {
      reason: COLLECTION_CHECK[Number(log.args.reason)] ?? String(log.args.reason),
      txHash: log.txHash,
    });
  },

  async SubscriptionCancelled(tx, log, blockTime, ctx) {
    const a = log.args;
    const subId = big(a.subscriptionId);
    const sub = await ensureSubRow(tx, ctx.chain, subId, log.txHash);
    if (!sub) return;
    // A cancel inside a collection batch, right after that subscription's failed or skipped charge, is the contract
    // releasing a lapsed subscription (still unpaid one interval after its due date), not a merchant decision.
    const lapsed = await tx`
      SELECT 1 FROM chain_events
      WHERE tx_hash = ${log.txHash.toLowerCase()} AND log_index < ${log.logIndex}
        AND event_name IN ('PaymentFailed', 'CollectionSkipped') AND args->>'subscriptionId' = ${subId.toString()}
      LIMIT 1`;
    const by: "subscriber" | "merchant" | "lapsed" =
      lc(a.cancelledBy) === sub.subscriber_address ? "subscriber" : lapsed.length ? "lapsed" : "merchant";
    const at = toDate(a.cancelledAt) ?? blockTime;
    await tx`UPDATE subscriptions SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ${at}::timestamptz),
               cancelled_by = COALESCE(cancelled_by, ${by}), synced_at = ${clock.now()} WHERE id = ${sub.id}`;
    await tx`UPDATE billing_jobs SET status = 'cancelled', locked_by = NULL, locked_until = NULL, updated_at = ${clock.now()}
             WHERE subscription_id = ${sub.id} AND status IN ('scheduled','retrying','processing')`;
    const m = await merchantInfo(tx, sub.merchant_id);
    const name = await planName(tx, sub.plan_id);
    await notify(tx, {
      address: sub.subscriber_address,
      kind: "subscription_cancelled",
      title: "Subscription cancelled",
      body:
        by === "subscriber"
          ? `You cancelled ${name} with ${m.name}. No further charges.`
          : by === "lapsed"
            ? `Your ${name} subscription with ${m.name} ended because a payment stayed unpaid for a full billing period. No further charges.`
            : `${m.name} cancelled your ${name} subscription. No further charges.`,
      link: links.subscriberSubscription(sub.id),
      dedupeKey: `cancelled:sub:${subId}`,
    });
    await notify(tx, {
      address: m.wallet_address,
      kind: "subscription_cancelled",
      title: "Subscription cancelled",
      body:
        by === "lapsed"
          ? `${short(sub.subscriber_address)} — ${name} ended: a payment stayed unpaid for a full billing period.`
          : `${short(sub.subscriber_address)} — ${name} was cancelled by the ${by}.`,
      link: links.merchantSubscription(sub.id),
      dedupeKey: `cancelled:merchant:${subId}`,
    });
    await enqueueWebhook(tx, {
      merchantId: sub.merchant_id,
      type: "subscription.cancelled",
      dedupeKey: `subscription.cancelled:${subId}`,
      data: { subscriptionId: subId.toString(), subscriber: sub.subscriber_address, cancelledBy: by, cancelledAt: at.toISOString(), txHash: log.txHash },
    });
  },

  async AuthorizationUpdated(tx, log, _bt, ctx) {
    const a = log.args;
    const subId = big(a.subscriptionId);
    const sub = await ensureSubRow(tx, ctx.chain, subId, log.txHash);
    if (!sub) return;
    await tx`UPDATE subscriptions SET remaining_cap = ${big(a.remainingCap)}::numeric, expires_at = ${toDate(a.expiresAt)},
               synced_at = ${clock.now()} WHERE id = ${sub.id}`;
    // A renewed authorization may make a skipped charge collectable again.
    await tx`UPDATE billing_jobs SET status = 'scheduled', next_attempt_at = ${clock.now()}, updated_at = ${clock.now()}
             WHERE subscription_id = ${sub.id} AND status = 'skipped'`;
    await enqueueWebhook(tx, {
      merchantId: sub.merchant_id,
      type: "authorization.updated",
      dedupeKey: `authorization.updated:${log.txHash}:${log.logIndex}`,
      data: { subscriptionId: subId.toString(), remainingCap: s(a.remainingCap), expiresAt: s(a.expiresAt), txHash: log.txHash },
    });
  },

  async AuthorizationRevoked(tx, log, _bt, ctx) {
    const subId = big(log.args.subscriptionId);
    const sub = await ensureSubRow(tx, ctx.chain, subId, log.txHash);
    if (!sub) return;
    await tx`UPDATE subscriptions SET remaining_cap = 0, synced_at = ${clock.now()} WHERE id = ${sub.id}`;
    await enqueueWebhook(tx, {
      merchantId: sub.merchant_id,
      type: "authorization.updated",
      dedupeKey: `authorization.revoked:${log.txHash}:${log.logIndex}`,
      data: { subscriptionId: subId.toString(), remainingCap: "0", revoked: true, txHash: log.txHash },
    });
  },

  async Refunded(tx, log, blockTime, ctx) {
    const a = log.args;
    const subId = big(a.subscriptionId);
    const sub = await ensureSubRow(tx, ctx.chain, subId, log.txHash);
    if (!sub) return;
    const amount = big(a.amount);
    const ins = await tx<{ id: string }>`
      INSERT INTO refunds (subscription_id, merchant_id, amount, transaction_hash, log_index, refunded_at)
      VALUES (${sub.id}, ${sub.merchant_id}, ${amount}::numeric, ${log.txHash}, ${log.logIndex}, ${blockTime})
      ON CONFLICT (transaction_hash, log_index) DO NOTHING RETURNING id`;
    if (ins.length === 0) return;
    // Chain re-reads may already include this refund; the refunds table is a lower bound of the chain total.
    await tx`UPDATE subscriptions SET total_refunded = GREATEST(total_refunded,
               (SELECT COALESCE(SUM(amount), 0) FROM refunds WHERE subscription_id = ${sub.id})), synced_at = ${clock.now()} WHERE id = ${sub.id}`;
    // Also listed in payment history (status 'refunded') against the latest paid period.
    await tx`
      INSERT INTO payments (subscription_id, merchant_id, period_index, amount, status, transaction_hash, log_index, block_number,
        collector, paid_at, created_at)
      VALUES (${sub.id}, ${sub.merchant_id}, ${Math.max(0, sub.payments_count - 1)}, ${amount}::numeric, 'refunded', ${log.txHash},
        ${log.logIndex}, ${log.blockNumber}, ${null}, ${blockTime}, ${blockTime})
      ON CONFLICT DO NOTHING`;
    await enqueueWebhook(tx, {
      merchantId: sub.merchant_id,
      type: "refund.created",
      dedupeKey: `refund.created:${log.txHash}:${log.logIndex}`,
      data: { subscriptionId: subId.toString(), subscriber: lc(a.subscriber), amount: amount.toString(), txHash: log.txHash },
    });
  },
};

export const HANDLED_EVENTS = Object.keys(handlers);

function short(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/**
 * Apply one decoded log in its own DB transaction. Returns false when it had already been applied.
 * Unknown events (e.g. AccessControl RoleGranted) are recorded and ignored.
 */
export async function applyEvent(sql: Sql, log: DecodedLog, blockTime: Date, ctx: ApplyContext): Promise<boolean> {
  return sql.begin(async (tx) => {
    const args = argsToJson(log.args);
    const ins = await tx<{ id: string }>`
      INSERT INTO chain_events (contract, event_name, block_number, block_hash, tx_hash, log_index, args, block_time)
      VALUES (${log.contract}, ${log.eventName}, ${log.blockNumber}, ${log.blockHash}, ${log.txHash.toLowerCase()}, ${log.logIndex},
              ${args}::jsonb, ${blockTime})
      ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING id`;
    let eventId: string;
    if (ins.length) eventId = str(ins[0].id);
    else {
      const [ev] = await tx<{ id: string; processed_at: Date | null }>`
        SELECT id, processed_at FROM chain_events WHERE tx_hash = ${log.txHash.toLowerCase()} AND log_index = ${log.logIndex}`;
      if (!ev || ev.processed_at) return false;
      eventId = str(ev.id);
    }
    const h = handlers[log.eventName];
    if (h) await h(tx, log, blockTime, ctx);
    await tx`UPDATE chain_events SET processed_at = ${clock.now()} WHERE id = ${eventId}`;
    return true;
  });
}

/** Apply many logs in (block, logIndex) order; block times are fetched once per block. */
export async function applyLogs(sql: Sql, chain: ChainAdapter, logs: DecodedLog[], ctx: Omit<ApplyContext, "chain"> = {}): Promise<number> {
  const sorted = [...logs].sort((x, y) => (x.blockNumber === y.blockNumber ? x.logIndex - y.logIndex : x.blockNumber < y.blockNumber ? -1 : 1));
  const times = new Map<bigint, Date>();
  let applied = 0;
  for (const l of sorted) {
    let t = times.get(l.blockNumber);
    if (!t) {
      try {
        t = new Date(Number((await chain.getBlock(l.blockNumber)).timestamp) * 1000);
      } catch {
        t = clock.now();
      }
      times.set(l.blockNumber, t);
    }
    try {
      if (await applyEvent(sql, l, t, { chain, ...ctx })) applied++;
    } catch (e) {
      if (isTransientError(e)) throw e; // whole pass retried next time; cursor not advanced
      // Poison event (constraint violation, bad data, handler bug): record it and keep indexing everyone else.
      // Reconciliation re-reads subscription state from the chain, so totals recover without this event.
      await recordFailedEvent(sql, l, t, e);
    }
  }
  // Remember the block hashes of everything applied (including confirm-endpoint / keeper receipts that run ahead
  // of the indexer cursor) so checkReorg can detect and unwind them.
  const seen = new Map<bigint, string>();
  for (const l of sorted) seen.set(l.blockNumber, l.blockHash);
  for (const [n, h] of seen) {
    await sql`INSERT INTO indexed_blocks (block_number, block_hash) VALUES (${n}, ${h})
              ON CONFLICT (block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash`;
  }
  return applied;
}

async function recordFailedEvent(sql: Sql, log: DecodedLog, blockTime: Date, e: unknown): Promise<void> {
  const message = ((e as Error)?.message ?? String(e)).slice(0, 500);
  console.error("[indexer] event failed, skipped", log.eventName, log.txHash, log.logIndex, message);
  await sql`
    INSERT INTO chain_events (contract, event_name, block_number, block_hash, tx_hash, log_index, args, block_time, error)
    VALUES (${log.contract}, ${log.eventName}, ${log.blockNumber}, ${log.blockHash}, ${log.txHash.toLowerCase()}, ${log.logIndex},
            ${argsToJson(log.args)}::jsonb, ${blockTime}, ${message})
    ON CONFLICT (tx_hash, log_index) DO UPDATE SET error = EXCLUDED.error`;
  await audit(sql, "indexer", "event_failed", `${log.txHash}:${log.logIndex}`, { event: log.eventName, error: message });
}

// ---------------------------------------------------------------- chain → DB sync (reconciliation)

/** Overwrite a subscription's [chain] columns from getSubscription. Returns the list of mismatched fields. */
export async function syncSubscriptionFromChain(sql: Sql, chain: ChainAdapter, onchainId: bigint, actor = "indexer"): Promise<string[]> {
  const cs = await chain.getSubscription(onchainId);
  if (cs.status === 0) return [];
  return sql.begin(async (tx) => {
    const [row] = await tx<Record<string, unknown>>`SELECT * FROM subscriptions WHERE onchain_subscription_id = ${onchainId}`;
    if (!row) {
      await insertSubFromChain(tx, chain, onchainId, cs, "0x");
      return ["missing_row"];
    }
    const expected: Record<string, string> = {
      remaining_cap: cs.remainingCap.toString(),
      payments_count: String(cs.paymentsCount),
      total_paid: cs.totalPaid.toString(),
      total_refunded: cs.totalRefunded.toString(),
      status: cs.status === 2 ? "cancelled" : "active",
      next_billing_at: String(Number(cs.nextBillingAt)),
      expires_at: String(Number(cs.expiresAt)),
      intro_amount: cs.introAmount.toString(),
      intro_periods: String(cs.introPeriods),
    };
    const actual: Record<string, string> = {
      remaining_cap: big(row.remaining_cap).toString(),
      payments_count: String(int(row.payments_count)),
      total_paid: big(row.total_paid).toString(),
      total_refunded: big(row.total_refunded).toString(),
      status: String(row.status),
      next_billing_at: String(Math.floor(new Date(row.next_billing_at as string).getTime() / 1000)),
      expires_at: row.expires_at ? String(Math.floor(new Date(row.expires_at as string).getTime() / 1000)) : "0",
      intro_amount: big(row.intro_amount).toString(),
      intro_periods: String(int(row.intro_periods)),
    };
    const diffs = Object.keys(expected).filter((k) => expected[k] !== actual[k]);
    await tx`
      UPDATE subscriptions SET remaining_cap = ${cs.remainingCap}::numeric, expires_at = ${toDate(cs.expiresAt)},
        next_billing_at = ${toDate(cs.nextBillingAt) ?? clock.now()}, payments_count = ${cs.paymentsCount},
        total_paid = ${cs.totalPaid}::numeric, total_refunded = ${cs.totalRefunded}::numeric,
        status = ${cs.status === 2 ? "cancelled" : "active"}, intro_amount = ${cs.introAmount}::numeric, intro_periods = ${cs.introPeriods},
        amount = ${cs.amount}::numeric, terms_version = ${cs.termsVersion}, billing_interval = ${cs.interval},
        last_payment_at = COALESCE(${toDate(cs.lastPaymentAt)}::timestamptz, last_payment_at),
        cancelled_at = COALESCE(cancelled_at, ${toDate(cs.cancelledAt)}::timestamptz), synced_at = ${clock.now()}
      WHERE id = ${String(row.id)}`;
    if (cs.status === 2) {
      await tx`UPDATE billing_jobs SET status = 'cancelled', updated_at = ${clock.now()}
               WHERE subscription_id = ${String(row.id)} AND status IN ('scheduled','retrying','processing')`;
    }
    if (diffs.length) {
      await audit(tx, actor, "reconcile_mismatch", String(row.id), {
        onchainSubscriptionId: onchainId.toString(),
        merchantId: String(row.merchant_id),
        fields: Object.fromEntries(diffs.map((k) => [k, { db: actual[k], chain: expected[k] }])),
      });
    }
    return diffs;
  });
}

export async function syncPlanFromChain(sql: Sql, chain: ChainAdapter, onchainPlanId: bigint): Promise<void> {
  const p = await chain.getPlan(onchainPlanId);
  if (p.status === 0) return;
  const status = CHAIN_PLAN_STATUS[p.status] ?? "active";
  await sql`
    UPDATE plans SET price = ${p.amount}::numeric, billing_interval = ${p.interval}, trial_seconds = ${p.trialPeriod},
      intro_price = ${p.introAmount}::numeric, intro_periods = ${p.introPeriods}, max_subscribers = ${p.maxSubscribers},
      terms_version = ${p.termsVersion}, status = ${status}, token_address = ${lc(p.token)}, updated_at = ${clock.now()}
    WHERE onchain_plan_id = ${onchainPlanId}`;
}

export async function syncMerchantFromChain(sql: Sql, chain: ChainAdapter, onchainId: bigint): Promise<void> {
  const m = await chain.getMerchant(onchainId);
  if (m.status === 0) return;
  const status = CHAIN_MERCHANT_STATUS[m.status] ?? "active";
  await sql`
    UPDATE merchants SET payout_address = ${lc(m.payout)}, chain_status = ${status}, keeper_enabled = ${m.keeperEnabled},
      updated_at = ${clock.now()}
    WHERE onchain_merchant_id = ${onchainId} AND wallet_address = ${lc(m.owner)}`;
}

// ---------------------------------------------------------------- indexer loop

const MAX_CHUNK = 2000n;
const REORG_DEPTH = 12;

export interface IndexerPassResult {
  from: bigint | null;
  to: bigint | null;
  head: bigint | null;
  logs: number;
  applied: number;
  rewoundTo: bigint | null;
  reconciled: number;
}

async function getCursor(sql: Sql): Promise<bigint> {
  const [row] = await sql<{ last_block: string | number }>`SELECT last_block FROM indexer_state WHERE id = 'main'`;
  if (row) return big(row.last_block);
  const start = contracts.deployBlock > 0n ? contracts.deployBlock - 1n : 0n;
  await sql`INSERT INTO indexer_state (id, last_block, updated_at) VALUES ('main', ${start}, ${clock.now()}) ON CONFLICT (id) DO NOTHING`;
  return start;
}

async function setCursor(sql: Sql, block: bigint, hash: string | null) {
  await sql`UPDATE indexer_state SET last_block = ${block}, last_block_hash = ${hash}, updated_at = ${clock.now()} WHERE id = 'main'`;
}

/**
 * Reorg check: compare the last REORG_DEPTH stored block hashes with the chain. On mismatch, delete everything
 * derived from the first mismatching block onward and rewind the cursor so those blocks are re-indexed.
 * Returns the block the cursor was rewound to (cursor = block - 1), or null.
 */
export async function checkReorg(sql: Sql, chain: ChainAdapter): Promise<bigint | null> {
  const stored = await sql<{ block_number: string | number; block_hash: string }>`
    SELECT block_number, block_hash FROM indexed_blocks ORDER BY block_number DESC LIMIT ${REORG_DEPTH}`;
  let forkAt: bigint | null = null;
  for (const b of stored) {
    const n = big(b.block_number);
    const live = await chain.getBlock(n);
    if (live.hash.toLowerCase() === b.block_hash.toLowerCase()) break; // older blocks are canonical too
    forkAt = n;
  }
  if (forkAt === null) return null;
  const affected = await rewindFrom(sql, forkAt);
  // Their running totals still include the orphaned charges; the chain is the truth.
  for (const id of affected) await syncSubscriptionFromChain(sql, chain, id, "reorg");
  return forkAt;
}

/** Returns on-chain ids of surviving subscriptions whose payment/refund rows were removed (caller re-syncs them). */
export async function rewindFrom(sql: Sql, block: bigint): Promise<bigint[]> {
  const affected: bigint[] = [];
  await sql.begin(async (tx) => {
    const evs = await tx<{ tx_hash: string }>`SELECT DISTINCT tx_hash FROM chain_events WHERE block_number >= ${block}`;
    const hashes = evs.map((e) => e.tx_hash);
    if (hashes.length) {
      const list = tx.join(hashes.map((h) => tx.frag`${h}`), ", ");
      // Subscriptions created in orphaned blocks disappear with everything that hangs off them.
      const subs = await tx<{ id: string }>`SELECT id FROM subscriptions WHERE subscribe_tx_hash IN (${list})`;
      if (subs.length) {
        const ids = tx.join(subs.map((x) => tx.frag`${x.id}`), ", ");
        await tx`DELETE FROM billing_jobs WHERE subscription_id IN (${ids})`;
        await tx`DELETE FROM payments WHERE subscription_id IN (${ids})`;
        await tx`DELETE FROM refunds WHERE subscription_id IN (${ids})`;
        await tx`DELETE FROM subscriptions WHERE id IN (${ids})`;
      }
      const touched = await tx<{ onchain_subscription_id: string }>`
        SELECT DISTINCT s.onchain_subscription_id FROM subscriptions s
        WHERE s.id IN (SELECT subscription_id FROM payments WHERE transaction_hash IN (${list})
                       UNION SELECT subscription_id FROM refunds WHERE transaction_hash IN (${list}))`;
      for (const t of touched) affected.push(big(t.onchain_subscription_id));
      await tx`DELETE FROM payments WHERE transaction_hash IN (${list})`;
      await tx`DELETE FROM refunds WHERE transaction_hash IN (${list})`;
      await tx`UPDATE billing_jobs SET status = 'scheduled', tx_hash = NULL, updated_at = ${clock.now()}
               WHERE tx_hash IN (${list}) AND status = 'succeeded'`;
    }
    await tx`DELETE FROM chain_events WHERE block_number >= ${block}`;
    await tx`DELETE FROM indexed_blocks WHERE block_number >= ${block}`;
    await tx`UPDATE indexer_state SET last_block = LEAST(last_block, ${block - 1n}), updated_at = ${clock.now()} WHERE id = 'main'`;
    await audit(tx, "indexer", "reorg_rewind", block.toString(), { txs: hashes.length });
  });
  return affected;
}

/** Re-read chain state for every active subscription (and registered merchants), logging mismatches. */
export async function reconcileAll(sql: Sql, chain: ChainAdapter, limit = 500): Promise<number> {
  const subs = await sql<{ onchain_subscription_id: string }>`
    SELECT onchain_subscription_id FROM subscriptions WHERE status = 'active' ORDER BY synced_at ASC LIMIT ${limit}`;
  let n = 0;
  for (const r of subs) {
    try {
      await syncSubscriptionFromChain(sql, chain, big(r.onchain_subscription_id), "reconcile");
      n++;
    } catch (e) {
      console.warn("[reconcile] subscription", r.onchain_subscription_id, (e as Error).message);
    }
  }
  const merchants = await sql<{ onchain_merchant_id: string }>`SELECT onchain_merchant_id FROM merchants WHERE onchain_merchant_id IS NOT NULL`;
  for (const m of merchants) {
    try {
      await syncMerchantFromChain(sql, chain, big(m.onchain_merchant_id));
    } catch {
      /* best effort */
    }
  }
  return n;
}

let passCount = 0;

export async function runIndexerPass(
  sql: Sql,
  chain: ChainAdapter,
  opts: { confirmations?: number; maxBlocks?: bigint; reconcile?: boolean } = {},
): Promise<IndexerPassResult> {
  const result: IndexerPassResult = { from: null, to: null, head: null, logs: 0, applied: 0, rewoundTo: null, reconciled: 0 };
  if (!isDeployed) return result;
  const confirmations = BigInt(opts.confirmations ?? env.confirmations());
  const head = await chain.getBlockNumber();
  result.head = head;
  result.rewoundTo = await checkReorg(sql, chain);
  let cursor = await getCursor(sql);
  const target = head - confirmations;
  const maxBlocks = opts.maxBlocks ?? 20_000n; // per pass, so a long catch-up doesn't starve the scheduler
  const end = target < cursor + maxBlocks ? target : cursor + maxBlocks;
  if (end > cursor) result.from = cursor + 1n;
  while (cursor < end) {
    const from = cursor + 1n;
    const to = from + MAX_CHUNK - 1n < end ? from + MAX_CHUNK - 1n : end;
    const raw = await chain.getLogs({ fromBlock: from, toBlock: to });
    const decoded = raw.map(decodeLog).filter((l): l is DecodedLog => l !== null);
    result.logs += decoded.length;
    result.applied += await applyLogs(sql, chain, decoded);
    // Remember hashes of blocks with logs + the chunk tip for the reorg check.
    const toBlock = await chain.getBlock(to);
    const seen = new Map<bigint, string>();
    for (const l of decoded) seen.set(l.blockNumber, l.blockHash);
    seen.set(to, toBlock.hash);
    for (const [n, h] of seen) {
      await sql`INSERT INTO indexed_blocks (block_number, block_hash) VALUES (${n}, ${h})
                ON CONFLICT (block_number) DO UPDATE SET block_hash = EXCLUDED.block_hash`;
    }
    await setCursor(sql, to, toBlock.hash);
    cursor = to;
  }
  result.to = cursor;
  await sql`DELETE FROM indexed_blocks WHERE block_number < ${cursor - 500n}`;
  passCount++;
  if (opts.reconcile || (passCount - 1) % env.reconcileEvery() === 0) result.reconciled = await reconcileAll(sql, chain);
  return result;
}

/** Indexer lag for health/overview: cursor vs head. */
export async function indexerStatus(sql: Sql): Promise<{ lastBlock: bigint | null; updatedAt: Date | null }> {
  const [row] = await sql<{ last_block: string | number; updated_at: Date }>`SELECT last_block, updated_at FROM indexer_state WHERE id = 'main'`;
  return row ? { lastBlock: big(row.last_block), updatedAt: row.updated_at } : { lastBlock: null, updatedAt: null };
}

export type { Address, Hex };
