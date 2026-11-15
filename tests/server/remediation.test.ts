// Regression tests for the 2026-11-09 audit findings. Each test reproduces the failure scenario from the audit.
import "./setup-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contracts } from "@/lib/chain/config";
import { clock } from "@/lib/server/clock";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { applyLogs, ensureUser, isNotFoundRevert, isTransientError, runIndexerPass, syncSubscriptionFromChain } from "@/lib/server/indexer";
import { siweOrigin } from "@/lib/server/http";
import { pinnedFetch, safeLookup } from "@/lib/server/webhooks";
import { E18, FakeChain, MERCHANT, STRANGER, SUBSCRIBER, chainSub, decoded, rawLog, txHash } from "./fakes";
import { T0, collectLog, seedSubscribed } from "./scenario";

let sql: Sql;
let chain: FakeChain;
const one = async <T = Record<string, unknown>>(q: Promise<T[]>) => (await q)[0];

beforeEach(async () => {
  clock.set(() => new Date(Number(T0) * 1000 + 10_000));
  sql = await resetDbForTests();
  chain = new FakeChain();
});
afterEach(() => clock.set(null));

describe("F1: ownership transfer onto a wallet with a pending profile", () => {
  it("does not stall on webhook rows and moves the merchant to the new owner", async () => {
    await seedSubscribed(sql, chain);
    // STRANGER has a pending (never registered) profile with a queued webhook event.
    const uid = await ensureUser(sql, STRANGER);
    const [pending] = await sql<{ id: string }>`
      INSERT INTO merchants (owner_user_id, wallet_address, name, slug) VALUES (${uid}, ${STRANGER.toLowerCase()}, 'P', 'p') RETURNING id`;
    await sql`INSERT INTO webhook_events (merchant_id, event_type, dedupe_key, payload) VALUES (${pending.id}, 'ping', 'ping:1', '{}'::jsonb)`;

    const h = txHash("transfer");
    const log = rawLog("registry", "MerchantOwnershipTransferred", { merchantId: 1n, previousOwner: MERCHANT, newOwner: STRANGER }, { blockNumber: 9n, txHash: h, logIndex: 0 });
    await expect(applyLogs(sql, chain, decoded(log))).resolves.toBe(1);

    const [m] = await sql<{ wallet_address: string }>`SELECT wallet_address FROM merchants WHERE onchain_merchant_id = 1`;
    expect(m.wallet_address).toBe(STRANGER.toLowerCase());
    expect((await sql`SELECT 1 FROM merchants WHERE id = ${pending.id}`).length).toBe(0);
    const [ev] = await sql<{ processed_at: Date | null; error: string | null }>`SELECT processed_at, error FROM chain_events WHERE tx_hash = ${h.toLowerCase()}`;
    expect(ev.processed_at).not.toBeNull();
    expect(ev.error).toBeNull();
  });
});

describe("poison events are isolated, transient errors are retried", () => {
  it("records a failing event with its error and keeps applying the rest of the batch", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    // Malformed args make the handler throw (not a network problem).
    const badHash = txHash("bad");
    const bad = rawLog("manager", "PaymentCollected", {
      subscriptionId: 1n, merchantId: 1n, subscriber: SUBSCRIBER, payout: MERCHANT, token: contracts.musd, amount: 5n * E18,
      periodIndex: 1, billedFor: T0 + 300n, nextBillingAt: T0 + 600n, collector: MERCHANT,
    }, { blockNumber: 20n, txHash: badHash, logIndex: 0 });
    const [badDecoded] = decoded(bad);
    (badDecoded.args as Record<string, unknown>).amount = "not-a-number";
    const good = collectLog(21n, txHash("good"), 1);
    chain.subs.set(1n, chainSub({ paymentsCount: 2, totalPaid: 10n * E18, remainingCap: 50n * E18, nextBillingAt: T0 + 600n, lastPaymentAt: T0 + 300n }));

    const applied = await applyLogs(sql, chain, [badDecoded, ...decoded(good)]);
    expect(applied).toBe(1);
    const [failed] = await sql<{ error: string | null; processed_at: Date | null }>`SELECT error, processed_at FROM chain_events WHERE tx_hash = ${badHash.toLowerCase()}`;
    expect(failed.error).toBeTruthy();
    expect(failed.processed_at).toBeNull();
    const s = await one(sql<{ payments_count: number }>`SELECT payments_count FROM subscriptions WHERE id = ${subRowId}`);
    expect(Number(s.payments_count)).toBe(2); // the good event after the poison one was applied
    expect((await sql`SELECT 1 FROM audit_logs WHERE action = 'event_failed'`).length).toBe(1);
  });

  it("aborts the pass (no cursor advance, no silent drop) when the RPC fails while resolving an unknown subscription", async () => {
    chain.head = 30n;
    chain.logs.push(collectLog(25n, txHash("orphan"), 3, 77n));
    chain.failing.add("getSubscription");
    await expect(runIndexerPass(sql, chain, { confirmations: 0 })).rejects.toThrow(/HTTP request failed/);
    const ev = await sql`SELECT 1 FROM chain_events WHERE processed_at IS NOT NULL`;
    expect(ev.length).toBe(0);
    const st = await sql<{ last_block: number }>`SELECT last_block FROM indexer_state WHERE id = 'main'`;
    expect(st.length === 0 || Number(st[0].last_block) < 25).toBe(true);
  });

  it("classifies errors", () => {
    const http = Object.assign(new Error("HTTP request failed"), { name: "HttpRequestError" });
    expect(isTransientError(http)).toBe(true);
    expect(isTransientError(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isTransientError(Object.assign(new Error("dup"), { code: "23505" }))).toBe(false);
    expect(isTransientError(new SyntaxError("Cannot convert not-a-number to a BigInt"))).toBe(false);
    expect(isNotFoundRevert(new Error('The contract function "getSubscription" reverted. Error: SubscriptionNotFound()'))).toBe(true);
    expect(isNotFoundRevert(http)).toBe(false);
  });
});

describe("F2: totals are not double-counted when a chain re-read runs ahead of the indexer", () => {
  it("PaymentCollected after reconcile leaves total_paid / remaining_cap equal to the chain", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    // Period 1 collected by the merchant elsewhere; reconcile reads chain head before the indexer sees the log.
    chain.subs.set(1n, chainSub({ paymentsCount: 2, totalPaid: 10n * E18, remainingCap: 50n * E18, nextBillingAt: T0 + 600n, lastPaymentAt: T0 + 300n }));
    await syncSubscriptionFromChain(sql, chain, 1n, "reconcile");
    await applyLogs(sql, chain, decoded(collectLog(30n, txHash("p1"), 1)));
    const s = await one(sql<{ total_paid: string; remaining_cap: string; payments_count: number }>`
      SELECT total_paid, remaining_cap, payments_count FROM subscriptions WHERE id = ${subRowId}`);
    expect(String(s.total_paid)).toBe((10n * E18).toString());
    expect(String(s.remaining_cap)).toBe((50n * E18).toString());
    expect(Number(s.payments_count)).toBe(2);
    // and the payment row exists exactly once
    expect((await sql`SELECT 1 FROM payments WHERE subscription_id = ${subRowId} AND period_index = 1 AND status = 'succeeded'`).length).toBe(1);
  });

  it("PaymentCollected applied normally still updates totals", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    await applyLogs(sql, chain, decoded(collectLog(30n, txHash("p1"), 1)));
    const s = await one(sql<{ total_paid: string; remaining_cap: string }>`SELECT total_paid, remaining_cap FROM subscriptions WHERE id = ${subRowId}`);
    expect(String(s.total_paid)).toBe((10n * E18).toString());
    expect(String(s.remaining_cap)).toBe((50n * E18).toString());
  });

  it("Refunded after a chain re-read does not double total_refunded", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    chain.subs.set(1n, chainSub({ paymentsCount: 1, totalPaid: 5n * E18, totalRefunded: 2n * E18, remainingCap: 55n * E18, nextBillingAt: T0 + 300n, lastPaymentAt: T0 }));
    await syncSubscriptionFromChain(sql, chain, 1n, "reconcile");
    const r = rawLog("manager", "Refunded", { subscriptionId: 1n, merchantId: 1n, subscriber: SUBSCRIBER, amount: 2n * E18 }, { blockNumber: 31n, txHash: txHash("refund"), logIndex: 0 });
    await applyLogs(sql, chain, decoded(r));
    await applyLogs(sql, chain, decoded(r)); // replay
    const s = await one(sql<{ total_refunded: string }>`SELECT total_refunded FROM subscriptions WHERE id = ${subRowId}`);
    expect(String(s.total_refunded)).toBe((2n * E18).toString());
  });

  it("a reorg that removes a renewal resyncs the surviving subscription's totals from chain", async () => {
    // Index the full history through the loop so block hashes are tracked.
    const { subRowId } = await seedSubscribed(sql, chain);
    chain.head = 40n;
    await runIndexerPass(sql, chain, { confirmations: 0 });
    chain.logs.push(collectLog(42n, txHash("renew"), 1));
    chain.subs.set(1n, chainSub({ paymentsCount: 2, totalPaid: 10n * E18, remainingCap: 50n * E18, nextBillingAt: T0 + 600n, lastPaymentAt: T0 + 300n }));
    chain.head = 45n;
    await runIndexerPass(sql, chain, { confirmations: 0 });
    expect(String((await one(sql<{ total_paid: string }>`SELECT total_paid FROM subscriptions WHERE id = ${subRowId}`)).total_paid)).toBe((10n * E18).toString());

    // Block 42 is orphaned; on the canonical chain the renewal never happened.
    chain.fork.set(42n, 1);
    chain.fork.set(45n, 1);
    chain.logs = chain.logs.filter((l) => l.blockNumber !== 42n);
    chain.subs.set(1n, chainSub({ paymentsCount: 1, totalPaid: 5n * E18, remainingCap: 55n * E18, nextBillingAt: T0 + 300n, lastPaymentAt: T0 }));
    const res = await runIndexerPass(sql, chain, { confirmations: 0 });
    expect(res.rewoundTo).toBe(42n);
    const s = await one(sql<{ total_paid: string; remaining_cap: string; payments_count: number }>`
      SELECT total_paid, remaining_cap, payments_count FROM subscriptions WHERE id = ${subRowId}`);
    expect(String(s.total_paid)).toBe((5n * E18).toString());
    expect(String(s.remaining_cap)).toBe((55n * E18).toString());
    expect(Number(s.payments_count)).toBe(1);
  });
});

describe("F3: webhook transport validates the address it actually connects to", () => {
  it("safeLookup refuses hosts that resolve to private addresses", async () => {
    const err = await new Promise<NodeJS.ErrnoException | null>((res) => safeLookup("localhost", {}, (e) => res(e)));
    expect(err?.code).toBe("EPRIVATEADDR");
  });
  it("pinnedFetch never connects to a private target", async () => {
    await expect(pinnedFetch("https://localhost/hook", { method: "POST", body: "{}" })).rejects.toThrow(/private address/);
  });
});

describe("F5: sign-in domain is pinned in production", () => {
  it("ignores forged Host / X-Forwarded-Host headers in production", () => {
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const req = new Request("https://evil.example/api/auth/nonce", { headers: { host: "evil.example", "x-forwarded-host": "evil.example" } });
      const o = siweOrigin(req);
      expect(o.allowedDomains).not.toContain("evil.example");
      expect(o.domain).not.toBe("evil.example");
    } finally {
      (process.env as Record<string, string>).NODE_ENV = prev ?? "test";
    }
  });
});
