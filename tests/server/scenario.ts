// Shared scenario: merchant (pending profile) → registered → draft plan → PlanCreated → Subscribed + first PaymentCollected.
import type { Sql } from "@/lib/server/db";
import { contracts } from "@/lib/chain/config";
import { applyLogs, ensureUser } from "@/lib/server/indexer";
import { E18, FakeChain, MERCHANT, SUBSCRIBER, chainPlan, chainSub, decoded, rawLog, txHash } from "./fakes";

export const T0 = 1_800_000_000n; // chain time of the subscribe block

export async function seedMerchant(sql: Sql, wallet: string = MERCHANT, slug = "shop") {
  const uid = await ensureUser(sql, wallet);
  const [m] = await sql<{ id: string }>`
    INSERT INTO merchants (owner_user_id, wallet_address, name, slug) VALUES (${uid}, ${wallet.toLowerCase()}, 'Shop', ${slug}) RETURNING id`;
  return m.id;
}

export async function seedDraftPlan(sql: Sql, merchantId: string, over: { price?: bigint; slug?: string } = {}) {
  const [p] = await sql<{ id: string }>`
    INSERT INTO plans (merchant_id, slug, name, token_address, price, billing_interval, status)
    VALUES (${merchantId}, ${over.slug ?? "pro"}, 'Pro', ${contracts.musd.toLowerCase()}, ${over.price ?? 5n * E18}::numeric, 300, 'draft')
    RETURNING id`;
  return p.id;
}

export function registeredLogs(merchantRowId: string, block = 2n) {
  const h = txHash("register");
  return {
    hash: h,
    logs: [
      rawLog("registry", "MerchantRegistered", { merchantId: 1n, owner: MERCHANT, payout: MERCHANT, metadataURI: `mezosub:merchant:${merchantRowId}` }, { blockNumber: block, txHash: h, logIndex: 0 }),
    ],
  };
}

export function planCreatedLogs(block = 3n, over: { amount?: bigint; merchantId?: bigint; planId?: bigint } = {}) {
  const h = txHash("plan");
  return {
    hash: h,
    logs: [
      rawLog(
        "manager",
        "PlanCreated",
        {
          planId: over.planId ?? 1n, merchantId: over.merchantId ?? 1n, token: contracts.musd, amount: over.amount ?? 5n * E18, interval: 300,
          trialPeriod: 0, introAmount: 0n, introPeriods: 0, maxSubscribers: 0,
        },
        { blockNumber: block, txHash: h, logIndex: 0 },
      ),
    ],
  };
}

export function subscribeLogs(block = 4n, subId = 1n, subscriber = SUBSCRIBER) {
  const h = txHash("subscribe");
  return {
    hash: h,
    logs: [
      rawLog(
        "manager",
        "Subscribed",
        {
          subscriptionId: subId, planId: 1n, merchantId: 1n, subscriber, amount: 5n * E18, interval: 300, termsVersion: 1,
          spendCap: 60n * E18, expiresAt: 0n, nextBillingAt: T0 + 300n,
        },
        { blockNumber: block, txHash: h, logIndex: 0 },
      ),
      rawLog(
        "manager",
        "PaymentCollected",
        {
          subscriptionId: subId, merchantId: 1n, subscriber, payout: MERCHANT, token: contracts.musd, amount: 5n * E18, periodIndex: 0,
          billedFor: T0, nextBillingAt: T0 + 300n, collector: subscriber,
        },
        { blockNumber: block, txHash: h, logIndex: 1 },
      ),
    ],
  };
}

export function collectLog(block: bigint, hash: `0x${string}`, period: number, subId = 1n, collector: `0x${string}` = MERCHANT) {
  return rawLog(
    "manager",
    "PaymentCollected",
    {
      subscriptionId: subId, merchantId: 1n, subscriber: SUBSCRIBER, payout: MERCHANT, token: contracts.musd, amount: 5n * E18,
      periodIndex: period, billedFor: T0 + 300n * BigInt(period), nextBillingAt: T0 + 300n * BigInt(period + 1), collector,
    },
    { blockNumber: block, txHash: hash, logIndex: 0 },
  );
}

/** Full happy-path seed applied through the event handlers. Returns ids. */
export async function seedSubscribed(sql: Sql, chain: FakeChain) {
  const merchantRowId = await seedMerchant(sql);
  const draftId = await seedDraftPlan(sql, merchantRowId);
  chain.merchants.set(1n, { owner: MERCHANT, payout: MERCHANT, status: 1, keeperEnabled: true, createdAt: 0n, metadataURI: `mezosub:merchant:${merchantRowId}` });
  chain.plans.set(1n, chainPlan());
  chain.subs.set(1n, chainSub({ createdAt: T0, nextBillingAt: T0 + 300n, lastPaymentAt: T0 }));
  chain.timestamps.set(4n, T0);
  const r = registeredLogs(merchantRowId);
  const p = planCreatedLogs();
  const s = subscribeLogs();
  chain.addReceipt(r.hash, r.logs, { to: contracts.registry, from: MERCHANT });
  chain.addReceipt(p.hash, p.logs, { from: MERCHANT });
  chain.addReceipt(s.hash, s.logs);
  await applyLogs(sql, chain, decoded(...r.logs, ...p.logs, ...s.logs));
  const [sub] = await sql<{ id: string }>`SELECT id FROM subscriptions WHERE onchain_subscription_id = 1`;
  return { merchantRowId, draftId, subRowId: sub.id, subscribeHash: s.hash };
}
