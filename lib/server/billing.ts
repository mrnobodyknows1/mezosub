// Scheduler: job planner + leased executor + crash recovery (ARCHITECTURE.md "Scheduler semantics").
// The contract is the source of truth: every attempt starts with previewCollection(), and a duplicate attempt is
// harmless because the contract rejects a second charge for the same period (NotDue).

import type { Address, Hex } from "viem";
import { RETRYABLE_CHECKS, type CollectionCheck } from "@/lib/chain/config";
import { formatMusd } from "@/lib/money";
import type { Sql } from "./db";
import { big, int } from "./db/rows";
import { verifyReceipt, type ChainAdapter, type DecodedLog, type RawReceipt } from "./chain";
import { addSeconds, clock } from "./clock";
import { env } from "./env";
import { applyLogs, syncSubscriptionFromChain } from "./indexer";
import type { KeeperAdapter } from "./keeper";
import { audit, enqueueWebhook, links, notify } from "./notify";

export interface BillingDeps {
  sql: Sql;
  chain: ChainAdapter;
  keeper: KeeperAdapter | null;
  workerId?: string;
  /** How long the executor waits in-line for a receipt before leaving the job `submitted` (recovery takes over). */
  receiptWaitMs?: number;
  receiptPollMs?: number;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface JobRow {
  id: string;
  subscription_id: string;
  period_index: number;
  scheduled_at: Date;
  next_attempt_at: Date;
  status: string;
  retry_count: number;
  last_attempt_at: Date | null;
  last_error: string | null;
  tx_hash: string | null;
  tx_nonce: number | null;
  locked_by: string | null;
  locked_until: Date | null;
}

const LEASE_SECONDS = 120;
const RPC_BACKOFF_SECONDS = 60;
const PAUSED_BACKOFF_SECONDS = 300;
const SKIPPED_RECHECK_SECONDS = 6 * 3600;
const NON_RETRYABLE_SKIP: readonly CollectionCheck[] = [
  "not_found",
  "not_active",
  "authorization_expired",
  "spend_cap_exceeded",
  "merchant_inactive",
  "not_authorized",
];

function normJob(r: Record<string, unknown>): JobRow {
  return {
    ...(r as unknown as JobRow),
    period_index: int(r.period_index),
    retry_count: int(r.retry_count),
    tx_nonce: r.tx_nonce === null || r.tx_nonce === undefined ? null : int(r.tx_nonce),
  };
}

const defaultLog = (msg: string, extra?: Record<string, unknown>) => console.log(`[billing] ${msg}`, extra ?? "");

// ---------------------------------------------------------------- planner

/** Ensure one job per (active subscription, current period); settle/cancel stale ones. Returns jobs created. */
export async function planJobs(sql: Sql): Promise<number> {
  const now = clock.now();
  return sql.begin(async (tx) => {
    const created = await tx<{ id: string }>`
      INSERT INTO billing_jobs (subscription_id, period_index, scheduled_at, next_attempt_at, status, created_at, updated_at)
      SELECT s.id, s.payments_count, s.next_billing_at, s.next_billing_at, 'scheduled', ${now}, ${now}
      FROM subscriptions s WHERE s.status = 'active'
      ON CONFLICT (subscription_id, period_index) DO NOTHING
      RETURNING id`;
    // Older periods that the chain says were paid (manual collect, another worker, ...) → succeeded.
    await tx`
      UPDATE billing_jobs j SET status = 'succeeded', locked_by = NULL, locked_until = NULL, updated_at = ${now}
      FROM subscriptions s
      WHERE j.subscription_id = s.id AND j.period_index < s.payments_count
        AND j.status IN ('scheduled','retrying','processing','failed_final','skipped')`;
    // Keep the current period's schedule aligned with the chain (trial end, schedule changes).
    await tx`
      UPDATE billing_jobs j SET scheduled_at = s.next_billing_at, next_attempt_at = s.next_billing_at, updated_at = ${now}
      FROM subscriptions s
      WHERE j.subscription_id = s.id AND j.period_index = s.payments_count AND j.status = 'scheduled'
        AND j.scheduled_at <> s.next_billing_at`;
    // Cancelled subscriptions → cancel open jobs.
    await tx`
      UPDATE billing_jobs j SET status = 'cancelled', locked_by = NULL, locked_until = NULL, updated_at = ${now}
      FROM subscriptions s
      WHERE j.subscription_id = s.id AND s.status = 'cancelled' AND j.status IN ('scheduled','retrying','processing')`;
    // Structural skips are re-checked periodically (authorization renewed, keeper re-enabled, merchant resumed...).
    await tx`
      UPDATE billing_jobs j SET status = 'scheduled', next_attempt_at = ${now}, updated_at = ${now}
      FROM subscriptions s
      WHERE j.subscription_id = s.id AND s.status = 'active' AND j.period_index = s.payments_count AND j.status = 'skipped'
        AND j.updated_at < ${addSeconds(now, -SKIPPED_RECHECK_SECONDS)}`;
    return created.length;
  });
}

// ---------------------------------------------------------------- lease

export async function claimJobs(sql: Sql, workerId: string, limit = 10): Promise<JobRow[]> {
  const now = clock.now();
  const lockClause = sql.kind === "postgres" ? sql.raw("FOR UPDATE SKIP LOCKED") : sql.raw("");
  // PGlite is a single connection and the driver serialises top-level statements, so the UPDATE … WHERE id IN
  // (SELECT …) below is atomic there without row locks.
  const rows = await sql<Record<string, unknown>>`
    UPDATE billing_jobs SET status = 'processing', locked_by = ${workerId}, locked_until = ${addSeconds(now, LEASE_SECONDS)},
      last_attempt_at = ${now}, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM billing_jobs
      WHERE (status IN ('scheduled','retrying') AND next_attempt_at <= ${now})
         OR (status = 'processing' AND locked_until < ${now})
      ORDER BY next_attempt_at ASC
      LIMIT ${limit}
      ${lockClause}
    )
    RETURNING *`;
  return rows.map(normJob);
}

async function claimSubmitted(sql: Sql, workerId: string, limit = 10): Promise<JobRow[]> {
  const now = clock.now();
  const lockClause = sql.kind === "postgres" ? sql.raw("FOR UPDATE SKIP LOCKED") : sql.raw("");
  const rows = await sql<Record<string, unknown>>`
    UPDATE billing_jobs SET locked_by = ${workerId}, locked_until = ${addSeconds(now, LEASE_SECONDS)}, updated_at = ${now}
    WHERE id IN (
      SELECT id FROM billing_jobs
      WHERE status = 'submitted' AND (locked_until IS NULL OR locked_until < ${now})
      ORDER BY updated_at ASC LIMIT ${limit}
      ${lockClause}
    )
    RETURNING *`;
  return rows.map(normJob);
}

// ---------------------------------------------------------------- state transitions

async function setJob(sql: Sql, id: string, fields: { status: string; nextAttemptAt?: Date; lastError?: string | null; retryCount?: number; scheduledAt?: Date }) {
  const now = clock.now();
  await sql`
    UPDATE billing_jobs SET status = ${fields.status},
      next_attempt_at = COALESCE(${fields.nextAttemptAt ?? null}::timestamptz, next_attempt_at),
      scheduled_at = COALESCE(${fields.scheduledAt ?? null}::timestamptz, scheduled_at),
      last_error = CASE WHEN ${fields.lastError === undefined}::boolean THEN last_error ELSE ${fields.lastError ?? null} END,
      retry_count = COALESCE(${fields.retryCount ?? null}::int, retry_count),
      locked_by = NULL, locked_until = NULL, updated_at = ${now}
    WHERE id = ${id}`;
}

async function rpcBackoff(sql: Sql, job: JobRow, err: unknown, seconds = RPC_BACKOFF_SECONDS) {
  const msg = err instanceof Error ? err.message.split("\n")[0].slice(0, 200) : String(err);
  await setJob(sql, job.id, { status: "retrying", nextAttemptAt: addSeconds(clock.now(), seconds), lastError: `rpc: ${msg}` });
  return "rpc_backoff" as const;
}

interface SubInfo {
  id: string;
  onchainId: bigint;
  status: string;
  paymentsCount: number;
  merchantId: string;
  subscriber: string;
  planName: string;
  merchantName: string;
  merchantWallet: string;
  notifyOnFailure: boolean;
}

async function loadSub(sql: Sql, subscriptionId: string): Promise<SubInfo | null> {
  const [r] = await sql<Record<string, unknown>>`
    SELECT s.id, s.onchain_subscription_id, s.status, s.payments_count, s.merchant_id, s.subscriber_address,
           p.name AS plan_name, m.name AS merchant_name, m.wallet_address, m.notify_on_failure
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN merchants m ON m.id = s.merchant_id
    WHERE s.id = ${subscriptionId}`;
  if (!r) return null;
  return {
    id: String(r.id),
    onchainId: big(r.onchain_subscription_id),
    status: String(r.status),
    paymentsCount: int(r.payments_count),
    merchantId: String(r.merchant_id),
    subscriber: String(r.subscriber_address),
    planName: String(r.plan_name),
    merchantName: String(r.merchant_name),
    merchantWallet: String(r.wallet_address),
    notifyOnFailure: Boolean(r.notify_on_failure),
  };
}

/** Funding failure: record the attempt, schedule a retry or give up (failed_final → past_due). */
export async function recordFailure(sql: Sql, job: JobRow, sub: SubInfo, check: CollectionCheck, amount: bigint, collector: string | null) {
  const delays = env.retryDelays();
  const attempt = job.retry_count + 1;
  const final = attempt > delays.length;
  const now = clock.now();
  const nextAt = final ? null : addSeconds(now, delays[attempt - 1]);
  const amt = formatMusd(amount, { symbol: true });
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO payments (subscription_id, merchant_id, period_index, amount, status, attempt_number, collector, failure_reason, created_at)
      VALUES (${sub.id}, ${sub.merchantId}, ${job.period_index}, ${amount}::numeric, 'failed', ${attempt}, ${collector}, ${check}, ${now})`;
    await tx`
      UPDATE billing_jobs SET status = ${final ? "failed_final" : "retrying"}, retry_count = ${attempt}, last_error = ${check},
        next_attempt_at = ${nextAt ?? now}, locked_by = NULL, locked_until = NULL, updated_at = ${now}
      WHERE id = ${job.id}`;
    await tx`UPDATE subscriptions SET billing_status = ${final ? "past_due" : "retrying"} WHERE id = ${sub.id}`;

    const reasonText =
      check === "insufficient_balance" ? "not enough MUSD in the wallet" : check === "insufficient_allowance" ? "the MUSD approval is too low" : "the transfer failed";
    const retryText = nextAt ? ` We'll try again ${relative(nextAt, now)}.` : "";
    await notify(tx, {
      address: sub.subscriber,
      kind: final ? "past_due" : "payment_failed",
      title: final ? "Subscription past due" : "Payment failed",
      body: final
        ? `${sub.planName} with ${sub.merchantName} is past due (${reasonText}). Add MUSD or renew your authorization, then press Retry.`
        : `Your ${amt} payment for ${sub.planName} didn't go through: ${reasonText}.${retryText}`,
      link: links.subscriberSubscription(sub.id),
      dedupeKey: `${final ? "past_due" : "payment_failed"}:sub:${sub.id}:${job.period_index}:${attempt}`,
    });
    if (sub.notifyOnFailure) {
      await notify(tx, {
        address: sub.merchantWallet,
        kind: final ? "past_due" : "payment_failed",
        title: final ? "Subscriber past due" : "Payment failed",
        body: final
          ? `${short(sub.subscriber)} on ${sub.planName} is past due after ${attempt} attempts.`
          : `${amt} from ${short(sub.subscriber)} for ${sub.planName} failed (${reasonText}).${retryText}`,
        link: links.merchantSubscription(sub.id),
        dedupeKey: `${final ? "past_due" : "payment_failed"}:merchant:${sub.id}:${job.period_index}:${attempt}`,
      });
    }
    const data = {
      subscriptionId: sub.onchainId.toString(),
      subscriber: sub.subscriber,
      periodIndex: job.period_index,
      amount: amount.toString(),
      reason: check,
      attempt,
      nextRetryAt: nextAt?.toISOString() ?? null,
    };
    await enqueueWebhook(tx, { merchantId: sub.merchantId, type: "payment.failed", dedupeKey: `payment.failed:${sub.id}:${job.period_index}:${attempt}`, data });
    if (final) {
      await enqueueWebhook(tx, {
        merchantId: sub.merchantId,
        type: "subscription.past_due",
        dedupeKey: `subscription.past_due:${sub.id}:${job.period_index}:${attempt}`,
        data,
      });
    }
  });
  return final ? ("failed_final" as const) : ("retrying" as const);
}

function relative(at: Date, now: Date): string {
  const s = Math.round((at.getTime() - now.getTime()) / 1000);
  if (s < 3600) return `in ${Math.max(1, Math.round(s / 60))} minutes`;
  if (s < 86400 * 2) return `in ${Math.round(s / 3600)} hours`;
  return `in ${Math.round(s / 86400)} days`;
}
function short(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export type JobOutcome =
  | "succeeded"
  | "submitted"
  | "rescheduled"
  | "retrying"
  | "failed_final"
  | "skipped"
  | "cancelled"
  | "rpc_backoff"
  | "keeper_disabled";

/** Apply the outcome of a mined collect receipt. */
async function finishWithReceipt(deps: BillingDeps, job: JobRow, sub: SubInfo, receipt: RawReceipt): Promise<JobOutcome> {
  const { sql, chain } = deps;
  let matched: DecodedLog | undefined;
  try {
    const v = await verifyReceipt(
      { ...chain, getReceipt: async () => receipt },
      receipt.transactionHash,
      { to: "manager", events: ["PaymentCollected"], from: deps.keeper?.address, attempts: 1 },
    );
    matched = v.matched.find((l) => big(l.args.subscriptionId) === sub.onchainId && Number(l.args.periodIndex) === job.period_index);
    await applyLogs(sql, chain, v.logs); // payment row + job → succeeded via the same handler as the indexer
  } catch {
    // reverted / unexpected receipt → fall through to a chain read
  }
  if (matched) {
    await setJob(sql, job.id, { status: "succeeded", lastError: null });
    return "succeeded";
  }
  try {
    const cs = await chain.getSubscription(sub.onchainId);
    if (cs.paymentsCount > job.period_index) {
      await syncSubscriptionFromChain(sql, chain, sub.onchainId, "keeper");
      await setJob(sql, job.id, { status: "succeeded", lastError: null });
      return "succeeded";
    }
  } catch (e) {
    return rpcBackoff(sql, job, e);
  }
  // Reverted (e.g. raced by a manual collect or balance moved): re-preview on the next pass; not a payment failure.
  await setJob(sql, job.id, { status: "retrying", nextAttemptAt: clock.now(), lastError: receipt.status === "reverted" ? "tx_reverted" : "no_payment_log" });
  return "retrying";
}

async function waitReceipt(deps: BillingDeps, hash: Hex): Promise<RawReceipt | null> {
  const total = deps.receiptWaitMs ?? 60_000;
  const poll = deps.receiptPollMs ?? 2_000;
  const start = Date.now();
  for (;;) {
    try {
      const r = await deps.chain.getReceipt(hash);
      if (r) return r;
    } catch {
      /* keep polling */
    }
    if (Date.now() - start >= total) return null;
    await new Promise((r) => setTimeout(r, poll));
  }
}

async function submitCollect(deps: BillingDeps, job: JobRow, sub: SubInfo, opts: { replacementNonce?: number } = {}): Promise<JobOutcome> {
  const { sql, chain } = deps;
  const keeper = deps.keeper!;
  let nonce: number;
  let replacement = false;
  try {
    if (opts.replacementNonce !== undefined) {
      nonce = opts.replacementNonce;
      replacement = true;
    } else {
      const [latest, pending] = await Promise.all([
        chain.getTransactionCount(keeper.address, "latest"),
        chain.getTransactionCount(keeper.address, "pending"),
      ]);
      // A crash after broadcasting but before persisting the hash leaves tx_nonce set: reuse it while unmined.
      // Never reuse it if another in-flight job has since been given that nonce (we would replace its tx).
      const taken =
        job.tx_nonce !== null &&
        (await sql`SELECT 1 FROM billing_jobs WHERE tx_nonce = ${job.tx_nonce} AND id <> ${job.id}
                     AND status IN ('processing', 'submitted') LIMIT 1`).length > 0;
      if (job.tx_nonce !== null && latest <= job.tx_nonce && !taken) {
        nonce = job.tx_nonce;
        replacement = pending > job.tx_nonce;
      } else nonce = pending;
    }
  } catch (e) {
    return rpcBackoff(sql, job, e);
  }
  // Persist the nonce BEFORE broadcasting, the hash BEFORE waiting.
  await sql`UPDATE billing_jobs SET tx_nonce = ${nonce}, updated_at = ${clock.now()} WHERE id = ${job.id}`;
  let hash: Hex;
  try {
    hash = await keeper.sendCollect(sub.onchainId, nonce, { replacement });
  } catch (e) {
    return rpcBackoff(sql, job, e);
  }
  const now = clock.now();
  await sql`
    UPDATE billing_jobs SET status = 'submitted', tx_hash = ${hash}, tx_nonce = ${nonce}, last_attempt_at = ${now},
      locked_by = NULL, locked_until = ${addSeconds(now, env.txTimeoutSec())}, updated_at = ${now}
    WHERE id = ${job.id}`;
  (deps.log ?? defaultLog)("collect submitted", { sub: sub.onchainId.toString(), period: job.period_index, hash, nonce });
  const receipt = await waitReceipt(deps, hash);
  if (!receipt) return "submitted"; // recovery will pick it up after TX_TIMEOUT
  return finishWithReceipt(deps, job, sub, receipt);
}

/** Process one claimed job (status 'processing'). */
export async function executeJob(deps: BillingDeps, job: JobRow): Promise<JobOutcome> {
  const { sql, chain, keeper } = deps;
  if (!keeper) {
    await setJob(sql, job.id, { status: job.retry_count > 0 ? "retrying" : "scheduled" });
    return "keeper_disabled";
  }
  const sub = await loadSub(sql, job.subscription_id);
  if (!sub || sub.status === "cancelled") {
    await setJob(sql, job.id, { status: "cancelled" });
    return "cancelled";
  }
  if (job.period_index < sub.paymentsCount) {
    await setJob(sql, job.id, { status: "succeeded", lastError: null });
    return "succeeded";
  }
  let preview: { check: CollectionCheck; amount: bigint };
  try {
    preview = await chain.previewCollection(sub.onchainId, keeper.address as Address);
  } catch (e) {
    return rpcBackoff(sql, job, e);
  }
  const { check, amount } = preview;
  if (check === "ok") return submitCollect(deps, job, sub);
  if (check === "not_due") {
    try {
      const cs = await chain.getSubscription(sub.onchainId);
      if (cs.paymentsCount > job.period_index) {
        await syncSubscriptionFromChain(sql, chain, sub.onchainId, "keeper"); // paid elsewhere (manual collect)
        await setJob(sql, job.id, { status: "succeeded", lastError: null });
        return "succeeded";
      }
      const at = new Date(Number(cs.nextBillingAt) * 1000);
      await setJob(sql, job.id, { status: "scheduled", scheduledAt: at, nextAttemptAt: at, lastError: "not_due" });
      return "rescheduled";
    } catch (e) {
      return rpcBackoff(sql, job, e);
    }
  }
  if (RETRYABLE_CHECKS.includes(check)) {
    let due = amount;
    if (due === 0n) due = await chain.amountDue(sub.onchainId).catch(() => 0n);
    return recordFailure(sql, job, sub, check, due, keeper.address.toLowerCase());
  }
  if (check === "contract_paused") return rpcBackoff(sql, job, new Error("contract_paused"), PAUSED_BACKOFF_SECONDS);
  if (NON_RETRYABLE_SKIP.includes(check)) {
    await setJob(sql, job.id, { status: "skipped", lastError: check });
    return "skipped";
  }
  await setJob(sql, job.id, { status: "skipped", lastError: check });
  return "skipped";
}

/** Crash recovery for jobs left `submitted` (tx broadcast, outcome unknown). */
export async function recoverSubmitted(deps: BillingDeps): Promise<Record<string, JobOutcome>> {
  const { sql, chain, keeper } = deps;
  const out: Record<string, JobOutcome> = {};
  if (!keeper) return out;
  const jobs = await claimSubmitted(sql, deps.workerId ?? "worker");
  for (const job of jobs) {
    const sub = await loadSub(sql, job.subscription_id);
    if (!sub) {
      await setJob(sql, job.id, { status: "cancelled" });
      out[job.id] = "cancelled";
      continue;
    }
    try {
      const receipt = job.tx_hash ? await chain.getReceipt(job.tx_hash as Hex) : null;
      if (receipt) {
        out[job.id] = await finishWithReceipt(deps, job, sub, receipt);
        continue;
      }
      const cs = await chain.getSubscription(sub.onchainId);
      if (cs.paymentsCount > job.period_index) {
        await syncSubscriptionFromChain(sql, chain, sub.onchainId, "keeper");
        await setJob(sql, job.id, { status: "succeeded", lastError: null });
        out[job.id] = "succeeded";
        continue;
      }
      if (cs.status === 2) {
        await setJob(sql, job.id, { status: "cancelled" });
        out[job.id] = "cancelled";
        continue;
      }
      const latest = await chain.getTransactionCount(keeper.address, "latest");
      if (job.tx_nonce !== null && latest <= job.tx_nonce) {
        // Our tx is still unmined: replace it with the same nonce (fresh preview first, so we never resend a doomed tx).
        const preview = await chain.previewCollection(sub.onchainId, keeper.address);
        if (preview.check === "ok") {
          out[job.id] = await submitCollect(deps, job, sub, { replacementNonce: job.tx_nonce });
          continue;
        }
      }
      // Nonce consumed by something else (tx dropped) or the charge is no longer possible: fresh attempt.
      await sql`UPDATE billing_jobs SET tx_nonce = NULL WHERE id = ${job.id}`;
      await setJob(sql, job.id, { status: "retrying", nextAttemptAt: clock.now(), lastError: "tx_dropped" });
      out[job.id] = "retrying";
    } catch {
      // RPC trouble: keep it submitted and look again after a short backoff.
      await sql`UPDATE billing_jobs SET locked_by = NULL, locked_until = ${addSeconds(clock.now(), RPC_BACKOFF_SECONDS)} WHERE id = ${job.id}`;
      out[job.id] = "rpc_backoff";
    }
  }
  return out;
}

export interface ExecutorResult {
  keeper: string | null;
  planned: number;
  claimed: number;
  outcomes: Record<string, JobOutcome>;
}

export async function runScheduler(deps: BillingDeps, opts: { limit?: number } = {}): Promise<ExecutorResult> {
  const log = deps.log ?? defaultLog;
  const planned = await planJobs(deps.sql);
  if (!deps.keeper) {
    log("keeper disabled (no KEEPER_PRIVATE_KEY) — planning only; merchants can collect manually");
    return { keeper: null, planned, claimed: 0, outcomes: {} };
  }
  const outcomes: Record<string, JobOutcome> = await recoverSubmitted(deps);
  const jobs = await claimJobs(deps.sql, deps.workerId ?? "worker", opts.limit ?? 10);
  for (const job of jobs) {
    try {
      outcomes[job.id] = await executeJob(deps, job);
    } catch (e) {
      log("job error", { job: job.id, error: (e as Error).message });
      outcomes[job.id] = await rpcBackoff(deps.sql, job, e);
    }
  }
  return { keeper: deps.keeper.address.toLowerCase(), planned, claimed: jobs.length, outcomes };
}

/** "Retry now": re-queue the current retrying / failed_final job (no chain write). */
export async function requeueNow(sql: Sql, subscriptionId: string): Promise<boolean> {
  const now = clock.now();
  const rows = await sql<{ id: string }>`
    UPDATE billing_jobs j SET status = 'retrying', next_attempt_at = ${now}, locked_by = NULL, locked_until = NULL, updated_at = ${now}
    FROM subscriptions s
    WHERE j.subscription_id = s.id AND s.id = ${subscriptionId} AND s.status = 'active'
      AND j.period_index = s.payments_count AND j.status IN ('retrying','failed_final','skipped')
    RETURNING j.id`;
  return rows.length > 0;
}

/** Upcoming-charge reminders, 24h ahead, for non-demo intervals (≥ 1 day). */
export async function runUpcomingNotifications(sql: Sql): Promise<number> {
  const now = clock.now();
  const rows = await sql<Record<string, unknown>>`
    SELECT s.id, s.onchain_subscription_id, s.subscriber_address, s.payments_count, s.amount, s.intro_amount, s.intro_periods,
           s.next_billing_at, p.name AS plan_name, m.name AS merchant_name
    FROM subscriptions s JOIN plans p ON p.id = s.plan_id JOIN merchants m ON m.id = s.merchant_id
    WHERE s.status = 'active' AND s.billing_interval >= 86400
      AND s.next_billing_at > ${now} AND s.next_billing_at <= ${addSeconds(now, 86400)}`;
  let n = 0;
  for (const r of rows) {
    const pc = int(r.payments_count);
    const amount = pc < int(r.intro_periods) ? big(r.intro_amount) : big(r.amount);
    await notify(sql, {
      address: String(r.subscriber_address),
      kind: "upcoming_charge",
      title: "Upcoming payment",
      body: `${formatMusd(amount, { symbol: true })} for ${String(r.plan_name)} (${String(r.merchant_name)}) is due within 24 hours.`,
      link: links.subscriberSubscription(String(r.id)),
      dedupeKey: `upcoming:${String(r.id)}:${pc}`,
    });
    n++;
  }
  return n;
}


/** Collection results after which the contract releases a subscription once it is one interval past due. */
const LAPSE_CHECKS: readonly CollectionCheck[] = ["insufficient_balance", "insufficient_allowance", "authorization_expired", "spend_cap_exceeded"];
const RELEASE_RESEND_SECONDS = 1800;

/**
 * Release lapsed subscriptions: still unable to pay one full interval after the due date. The contract cancels such
 * a subscription inside collectDuePayments, which frees its plan seat (maxSubscribers). Only subscriptions the chain
 * confirms as lapsed are sent, one batch per pass, and a sent id is not resent for 30 minutes (the indexer marks it
 * cancelled once the tx is mined).
 */
export async function releaseLapsed(deps: BillingDeps, opts: { limit?: number } = {}): Promise<{ sent: number; hash: Hex | null }> {
  const { sql, chain, keeper } = deps;
  if (!keeper?.sendCollectDue) return { sent: 0, hash: null };
  const now = clock.now();
  const candidates = await sql<{ id: string; onchain_subscription_id: string }>`
    SELECT s.id, s.onchain_subscription_id FROM subscriptions s
    WHERE s.status = 'active' AND s.next_billing_at IS NOT NULL
      AND s.next_billing_at + make_interval(secs => s.billing_interval) <= ${now}
      AND NOT EXISTS (SELECT 1 FROM audit_logs a WHERE a.action = 'keeper.release_lapsed' AND a.resource_id = s.id::text
                        AND a.created_at > ${addSeconds(now, -RELEASE_RESEND_SECONDS)})
    ORDER BY s.next_billing_at LIMIT ${opts.limit ?? 20}`;
  const ids: { rowId: string; onchainId: bigint }[] = [];
  for (const c of candidates) {
    const onchainId = big(c.onchain_subscription_id);
    try {
      const [preview, cs] = await Promise.all([chain.previewCollection(onchainId, keeper.address), chain.getSubscription(onchainId)]);
      const lapsedOnChain = BigInt(Math.floor(now.getTime() / 1000)) >= BigInt(cs.nextBillingAt) + BigInt(cs.interval);
      if (LAPSE_CHECKS.includes(preview.check) && lapsedOnChain) ids.push({ rowId: c.id, onchainId });
    } catch {
      // RPC trouble: try again next pass
    }
  }
  if (!ids.length) return { sent: 0, hash: null };
  const nonce = await chain.getTransactionCount(keeper.address, "pending");
  const hash = await keeper.sendCollectDue(ids.map((x) => x.onchainId), nonce);
  for (const x of ids) await audit(sql, "keeper", "keeper.release_lapsed", x.rowId, { txHash: hash, onchainId: x.onchainId.toString() });
  return { sent: ids.length, hash };
}
