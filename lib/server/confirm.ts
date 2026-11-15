// Tx-confirm flows: verify a receipt (status, contract, sender, expected events, actor ownership), apply the
// logs with the indexer's handlers, then re-read chain state. Client-reported outcomes are never trusted.

import type { Hex } from "viem";
import type { Sql } from "./db";
import { big, int } from "./db/rows";
import { verifyReceipt, type ChainAdapter, type DecodedLog } from "./chain";
import { conflict, forbidden, HttpError, unprocessable } from "./errors";
import { applyLogs, syncMerchantFromChain, syncPlanFromChain, syncSubscriptionFromChain } from "./indexer";
import type { MerchantRow } from "./access";

const REGISTRY_EVENTS = [
  "MerchantRegistered",
  "MerchantPayoutChanged",
  "MerchantMetadataChanged",
  "MerchantStatusChanged",
  "MerchantKeeperAccessChanged",
  "MerchantOwnershipTransferred",
];

export async function confirmMerchantTx(sql: Sql, chain: ChainAdapter, merchant: MerchantRow, sessionAddress: string, txHash: Hex) {
  const v = await verifyReceipt(chain, txHash, { to: "registry", events: REGISTRY_EVENTS, from: sessionAddress });
  const myId = merchant.onchain_merchant_id === null || merchant.onchain_merchant_id === undefined ? null : big(merchant.onchain_merchant_id);
  let onchainId = myId;
  for (const l of v.matched) {
    if (l.eventName === "MerchantRegistered") {
      if (String(l.args.owner).toLowerCase() !== sessionAddress.toLowerCase()) throw forbidden("Registration owner is not your wallet");
      if (myId !== null && big(l.args.merchantId) !== myId) throw conflict("already_registered", "This profile is linked to another merchant id");
      onchainId = big(l.args.merchantId);
    } else if (myId === null || big(l.args.merchantId) !== myId) {
      throw forbidden("Transaction is for a different merchant");
    }
  }
  await applyLogs(sql, chain, v.logs);
  if (onchainId !== null) await syncMerchantFromChain(sql, chain, onchainId).catch(() => undefined);
  const [row] = await sql<MerchantRow>`SELECT * FROM merchants WHERE id = ${merchant.id}`;
  if (onchainId !== null && (row.onchain_merchant_id === null || big(row.onchain_merchant_id) !== onchainId)) {
    throw conflict("link_failed", "Registration confirmed on-chain but its metadataURI does not point to this profile");
  }
  return row;
}

export interface DraftTerms {
  token_address: unknown;
  price: unknown;
  billing_interval: unknown;
  trial_seconds: unknown;
  intro_price: unknown;
  intro_periods: unknown;
  max_subscribers: unknown;
}

export function termsMismatch(draft: DraftTerms, ev: Record<string, unknown>): string[] {
  const pairs: [string, string, string][] = [
    ["token", String(draft.token_address).toLowerCase(), String(ev.token).toLowerCase()],
    ["amount", big(draft.price).toString(), big(ev.amount).toString()],
    ["interval", String(int(draft.billing_interval)), String(Number(ev.interval))],
    ["trialPeriod", String(int(draft.trial_seconds)), String(Number(ev.trialPeriod))],
    ["introAmount", big(draft.intro_price).toString(), big(ev.introAmount).toString()],
    ["introPeriods", String(int(draft.intro_periods)), String(Number(ev.introPeriods))],
    ["maxSubscribers", String(int(draft.max_subscribers)), String(Number(ev.maxSubscribers))],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([k]) => k);
}

export async function confirmPlanTx(
  sql: Sql,
  chain: ChainAdapter,
  merchant: MerchantRow,
  plan: Record<string, unknown>,
  sessionAddress: string,
  txHash: Hex,
) {
  if (merchant.onchain_merchant_id === null || merchant.onchain_merchant_id === undefined) throw forbidden("Register your merchant account first");
  const myId = big(merchant.onchain_merchant_id);
  const v = await verifyReceipt(chain, txHash, {
    to: "manager",
    events: ["PlanCreated", "PlanUpdated", "PlanStatusChanged"],
    from: sessionAddress,
  });
  const planOnchain = plan.onchain_plan_id === null || plan.onchain_plan_id === undefined ? null : big(plan.onchain_plan_id);
  let linkDraft: string | undefined;
  let targetPlanId: bigint | null = planOnchain;
  for (const l of v.matched) {
    const pid = big(l.args.planId);
    if (l.eventName === "PlanCreated") {
      if (big(l.args.merchantId) !== myId) throw forbidden("Plan was created by a different merchant");
      if (planOnchain !== null) {
        if (pid !== planOnchain) throw conflict("plan_already_linked", "This plan is already linked to another on-chain plan");
        continue;
      }
      const diffs = termsMismatch(plan as unknown as DraftTerms, l.args);
      if (diffs.length) {
        // Record the chain truth (as its own plan row) and refuse to link the draft.
        await applyLogs(sql, chain, v.logs);
        throw conflict("terms_mismatch", "On-chain plan terms differ from the draft; the on-chain plan was saved separately", {
          fields: diffs,
          onchainPlanId: pid.toString(),
        });
      }
      linkDraft = String(plan.id);
      targetPlanId = pid;
    } else {
      if (planOnchain === null || pid !== planOnchain) throw unprocessable("wrong_plan", "Transaction is for a different plan");
      const onchain = await chain.getPlan(pid);
      if (onchain.merchantId !== myId) throw forbidden("Plan belongs to a different merchant");
    }
  }
  await applyLogs(sql, chain, v.logs, linkDraft ? { linkDraftPlanId: linkDraft } : {});
  if (targetPlanId !== null) await syncPlanFromChain(sql, chain, targetPlanId).catch(() => undefined);
  const [row] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${String(plan.id)}`;
  if (linkDraft && (row.onchain_plan_id === null || big(row.onchain_plan_id) !== targetPlanId)) {
    throw new HttpError(409, "link_failed", "Plan confirmed on-chain but could not be linked to this draft");
  }
  return row;
}

/** Public: confirms a subscribe/subscribeWithPermit tx. Returns the on-chain subscription ids created. */
export async function confirmSubscribeTx(sql: Sql, chain: ChainAdapter, txHash: Hex): Promise<bigint[]> {
  const v = await verifyReceipt(chain, txHash, { to: "manager", events: ["Subscribed"] });
  await applyLogs(sql, chain, v.logs);
  const ids = v.matched.map((l) => big(l.args.subscriptionId));
  for (const id of ids) await syncSubscriptionFromChain(sql, chain, id, "api").catch(() => undefined);
  return ids;
}

export const SUBSCRIPTION_SYNC_EVENTS = ["PaymentCollected", "SubscriptionCancelled", "AuthorizationUpdated", "AuthorizationRevoked", "Refunded"];

/** Subscriber or merchant: optional tx (collect/cancel/revoke/updateAuthorization/refund), then a chain re-read. */
export async function syncSubscription(
  sql: Sql,
  chain: ChainAdapter,
  onchainSubscriptionId: bigint,
  sessionAddress: string,
  txHash?: Hex,
): Promise<DecodedLog[]> {
  let logs: DecodedLog[] = [];
  if (txHash) {
    const v = await verifyReceipt(chain, txHash, { to: "manager", events: SUBSCRIPTION_SYNC_EVENTS, from: sessionAddress });
    if (!v.matched.some((l) => big(l.args.subscriptionId) === onchainSubscriptionId)) {
      throw unprocessable("wrong_subscription", "Transaction does not touch this subscription");
    }
    await applyLogs(sql, chain, v.logs);
    logs = v.logs;
  }
  await syncSubscriptionFromChain(sql, chain, onchainSubscriptionId, "api");
  return logs;
}
