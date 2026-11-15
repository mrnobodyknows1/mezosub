import "./setup-env";
import { beforeEach, describe, expect, it } from "vitest";
import { contracts } from "@/lib/chain/config";
import { clock } from "@/lib/server/clock";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { applyLogs, runIndexerPass, syncSubscriptionFromChain } from "@/lib/server/indexer";
import { E18, FakeChain, KEEPER, MERCHANT, STRANGER, SUBSCRIBER, chainPlan, chainSub, decoded, rawLog, txHash } from "./fakes";
import { T0, planCreatedLogs, registeredLogs, seedDraftPlan, seedMerchant, seedSubscribed, subscribeLogs } from "./scenario";

let sql: Sql;
let chain: FakeChain;
const count = async (table: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.raw(table)}`)[0].n);

beforeEach(async () => {
  clock.set(() => new Date(Number(T0) * 1000 + 10_000));
  sql = await resetDbForTests();
  chain = new FakeChain();
});

describe("event handlers", () => {
  it("links registration + draft plan, records subscribe + first payment", async () => {
    const { merchantRowId, draftId } = await seedSubscribed(sql, chain);
    const [m] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE id = ${merchantRowId}`;
    expect(String(m.onchain_merchant_id)).toBe("1");
    expect(m.chain_status).toBe("active");
    const [p] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${draftId}`;
    expect(String(p.onchain_plan_id)).toBe("1");
    expect(p.status).toBe("active");
    const [s] = await sql<Record<string, unknown>>`SELECT * FROM subscriptions`;
    expect(Number(s.payments_count)).toBe(1);
    expect(String(s.remaining_cap)).toBe((55n * E18).toString());
    expect(String(s.total_paid)).toBe((5n * E18).toString());
    expect(await count("payments")).toBe(1);
    const kinds = (await sql<{ kind: string }>`SELECT kind FROM notifications ORDER BY kind`).map((r) => r.kind);
    expect(kinds).toEqual(["new_subscriber", "payment_succeeded", "payment_succeeded"]);
    const [job] = await sql<{ status: string; period_index: number }>`SELECT status, period_index FROM billing_jobs`;
    expect(job.status).toBe("succeeded");
  });

  it("is idempotent: applying the same logs twice changes nothing", async () => {
    await seedSubscribed(sql, chain);
    const snapshot = async () => ({
      subs: await sql`SELECT remaining_cap, payments_count, total_paid FROM subscriptions`,
      payments: await count("payments"),
      notifications: await count("notifications"),
      webhooks: await count("webhook_events"),
      events: await count("chain_events"),
      jobs: await count("billing_jobs"),
    });
    const before = await snapshot();
    const s = await sql<{ tx_hash: string }>`SELECT tx_hash FROM chain_events`;
    const logs = s.flatMap((e) => chain.receipts.get(e.tx_hash)!.logs);
    const applied = await applyLogs(sql, chain, decoded(...logs));
    expect(applied).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("links a registration only when the owner matches the referenced row", async () => {
    const victimRow = await seedMerchant(sql, STRANGER, "victim");
    const h = txHash();
    // MERCHANT registers pointing at STRANGER's pending row
    const log = rawLog("registry", "MerchantRegistered", { merchantId: 7n, owner: MERCHANT, payout: MERCHANT, metadataURI: `mezosub:merchant:${victimRow}` }, { blockNumber: 2n, txHash: h, logIndex: 0 });
    await applyLogs(sql, chain, decoded(log));
    const [victim] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE id = ${victimRow}`;
    expect(victim.onchain_merchant_id).toBeNull();
    const [placeholder] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE onchain_merchant_id = 7`;
    expect(placeholder.wallet_address).toBe(MERCHANT.toLowerCase());
    expect(placeholder.name).toBe("Merchant #7");
  });

  it("Subscribed for an unknown plan creates a minimal plan row", async () => {
    const merchantRowId = await seedMerchant(sql);
    await applyLogs(sql, chain, decoded(...registeredLogs(merchantRowId).logs));
    chain.plans.set(1n, chainPlan());
    const s = subscribeLogs();
    await applyLogs(sql, chain, decoded(...s.logs));
    const [p] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE onchain_plan_id = 1`;
    expect(p.name).toBe("Plan #1");
    expect(p.slug).toBe("plan-1");
    expect(await count("subscriptions")).toBe(1);
  });

  it("cancel, authorization update and refund", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    const h = txHash();
    await applyLogs(
      sql,
      chain,
      decoded(
        rawLog("manager", "AuthorizationUpdated", { subscriptionId: 1n, remainingCap: 100n * E18, expiresAt: 0n }, { blockNumber: 6n, txHash: h, logIndex: 0 }),
        rawLog("manager", "Refunded", { subscriptionId: 1n, merchantId: 1n, subscriber: SUBSCRIBER, amount: 2n * E18 }, { blockNumber: 6n, txHash: h, logIndex: 1 }),
        rawLog("manager", "SubscriptionCancelled", { subscriptionId: 1n, cancelledBy: SUBSCRIBER, cancelledAt: T0 + 50n }, { blockNumber: 6n, txHash: h, logIndex: 2 }),
      ),
    );
    const [s] = await sql<Record<string, unknown>>`SELECT * FROM subscriptions WHERE id = ${subRowId}`;
    expect(String(s.remaining_cap)).toBe((100n * E18).toString());
    expect(String(s.total_refunded)).toBe((2n * E18).toString());
    expect(s.status).toBe("cancelled");
    expect(s.cancelled_by).toBe("subscriber");
    expect(await count("refunds")).toBe(1);
  });

  it("a cancel right after a failed charge in the same batch is labelled lapsed, not merchant", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    const h = txHash();
    await applyLogs(
      sql,
      chain,
      decoded(
        rawLog("manager", "PaymentFailed", { subscriptionId: 1n, periodIndex: 1, reason: 9, amount: 10n * E18, collector: KEEPER }, { blockNumber: 6n, txHash: h, logIndex: 0 }),
        rawLog("manager", "SubscriptionCancelled", { subscriptionId: 1n, cancelledBy: KEEPER, cancelledAt: T0 + 50n }, { blockNumber: 6n, txHash: h, logIndex: 1 }),
      ),
    );
    const [s] = await sql<Record<string, unknown>>`SELECT * FROM subscriptions WHERE id = ${subRowId}`;
    expect(s.status).toBe("cancelled");
    expect(s.cancelled_by).toBe("lapsed");
    const notes = await sql<{ body: string }>`SELECT body FROM notifications WHERE kind = 'subscription_cancelled'`;
    expect(notes.some((n) => n.body.includes("stayed unpaid"))).toBe(true);
  });

  it("a merchant cancel with no failed charge in the tx stays labelled merchant", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    await applyLogs(sql, chain, decoded(rawLog("manager", "SubscriptionCancelled", { subscriptionId: 1n, cancelledBy: MERCHANT, cancelledAt: T0 + 50n }, { blockNumber: 6n, txHash: txHash(), logIndex: 0 })));
    const [s] = await sql<Record<string, unknown>>`SELECT * FROM subscriptions WHERE id = ${subRowId}`;
    expect(s.cancelled_by).toBe("merchant");
  });

  it("reconciliation overwrites drifted chain columns and logs the mismatch", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    chain.subs.set(1n, chainSub({ remainingCap: 40n * E18, paymentsCount: 2, totalPaid: 10n * E18, nextBillingAt: T0 + 600n }));
    const diffs = await syncSubscriptionFromChain(sql, chain, 1n);
    expect(diffs).toEqual(expect.arrayContaining(["remaining_cap", "payments_count", "total_paid", "next_billing_at"]));
    const [s] = await sql<Record<string, unknown>>`SELECT * FROM subscriptions WHERE id = ${subRowId}`;
    expect(Number(s.payments_count)).toBe(2);
    expect(await count("audit_logs")).toBeGreaterThan(0);
  });
});

describe("indexer loop", () => {
  it("indexes logs in chunks and rewinds on a reorg", async () => {
    const merchantRowId = await seedMerchant(sql);
    await seedDraftPlan(sql, merchantRowId);
    chain.merchants.set(1n, { owner: MERCHANT, payout: MERCHANT, status: 1, keeperEnabled: true, createdAt: 0n, metadataURI: "" });
    chain.plans.set(1n, chainPlan());
    chain.subs.set(1n, chainSub({ nextBillingAt: T0 + 300n }));
    const r = registeredLogs(merchantRowId, 2n);
    const p = planCreatedLogs(3n);
    const s = subscribeLogs(8n);
    chain.logs.push(...r.logs, ...p.logs, ...s.logs);
    chain.head = 10n;
    const res = await runIndexerPass(sql, chain, { confirmations: 0 });
    expect(res.from).toBe(1n);
    expect(res.to).toBe(10n);
    expect(res.applied).toBe(4);
    expect(await count("subscriptions")).toBe(1);

    // Reorg: block 8 replaced; the subscribe tx is gone from the canonical chain.
    chain.fork.set(8n, 1);
    chain.fork.set(10n, 1);
    chain.logs = chain.logs.filter((l) => l.blockNumber !== 8n);
    chain.subs.clear();
    const res2 = await runIndexerPass(sql, chain, { confirmations: 0 });
    expect(res2.rewoundTo).toBe(8n);
    expect(await count("subscriptions")).toBe(0);
    expect(await count("payments")).toBe(0);
    const [st] = await sql<{ last_block: number }>`SELECT last_block FROM indexer_state WHERE id = 'main'`;
    expect(Number(st.last_block)).toBe(10);
    // Merchant/plan from earlier canonical blocks are untouched
    expect(await count("plans")).toBe(1);
    void contracts;
  });

  it("respects confirmations and resumes from the cursor", async () => {
    chain.head = 5000n;
    const res = await runIndexerPass(sql, chain, { confirmations: 2 });
    expect(res.to).toBe(4998n);
    const getLogsCalls = chain.calls.filter((c) => c === "getLogs").length;
    expect(getLogsCalls).toBe(3); // 1..2000, 2001..4000, 4001..4998
    chain.head = 5003n;
    const res2 = await runIndexerPass(sql, chain, { confirmations: 2 });
    expect(res2.from).toBe(4999n);
    expect(res2.to).toBe(5001n);
  });
});
