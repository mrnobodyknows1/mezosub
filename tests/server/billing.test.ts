import "./setup-env";
import { beforeEach, describe, expect, it } from "vitest";
import { planJobs, releaseLapsed, requeueNow, runScheduler, type BillingDeps } from "@/lib/server/billing";
import { addSeconds, clock } from "@/lib/server/clock";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { applyLogs } from "@/lib/server/indexer";
import { E18, FakeChain, FakeKeeper, KEEPER, chainSub, decoded, txHash } from "./fakes";
import { T0, collectLog, seedSubscribed } from "./scenario";

let sql: Sql;
let chain: FakeChain;
let keeper: FakeKeeper;
let now: Date;
const deps = (): BillingDeps => ({ sql, chain, keeper, workerId: "test", receiptWaitMs: 50, receiptPollMs: 5, log: () => {} });
const job = async () => (await sql<Record<string, unknown>>`SELECT * FROM billing_jobs WHERE period_index = 1`)[0];
const sub = async () => (await sql<Record<string, unknown>>`SELECT * FROM subscriptions`)[0];
const n = async (q: string) => Number((await sql<{ n: number }>`SELECT count(*)::int AS n FROM ${sql.raw(q)}`)[0].n);
function advance(sec: number) {
  now = addSeconds(now, sec);
}
/** Keeper sends → chain charges period `period` in a new block. */
function chargeOnSend(period = 1) {
  keeper.onSend = (_subId, _nonce, hash) => {
    chain.head += 1n;
    chain.addReceipt(hash, [collectLog(chain.head, hash, period, 1n, KEEPER)], { from: KEEPER });
    chain.subs.set(1n, chainSub({ paymentsCount: period + 1, remainingCap: 50n * E18, totalPaid: 10n * E18, nextBillingAt: T0 + 600n }));
    chain.previews.set(1n, { check: "not_due", amount: 5n * E18 });
  };
}

beforeEach(async () => {
  now = new Date(Number(T0) * 1000);
  clock.set(() => now);
  sql = await resetDbForTests();
  chain = new FakeChain();
  keeper = new FakeKeeper();
  await seedSubscribed(sql, chain);
  advance(301); // period 1 is due
});

describe("planner", () => {
  it("creates one job per (subscription, period), idempotently", async () => {
    expect(await planJobs(sql)).toBe(1);
    expect(await planJobs(sql)).toBe(0);
    const j = await job();
    expect(j.status).toBe("scheduled");
    expect(new Date(j.scheduled_at as string).getTime()).toBe(Number(T0 + 300n) * 1000);
  });
});

describe("executor", () => {
  it("ok → collect → receipt verified → succeeded (payment via the indexer handler)", async () => {
    chain.previews.set(1n, { check: "ok", amount: 5n * E18 });
    chain.nonceLatest = chain.noncePending = 7;
    chargeOnSend();
    const r = await runScheduler(deps());
    expect(Object.values(r.outcomes)).toEqual(["succeeded"]);
    const j = await job();
    expect(j.status).toBe("succeeded");
    expect(j.tx_hash).toBe(keeper.sent[0].hash);
    expect(Number(j.tx_nonce)).toBe(7);
    expect(Number((await sub()).payments_count)).toBe(2);
    expect(await n("payments WHERE status = 'succeeded'")).toBe(2);
    expect(keeper.sent).toHaveLength(1);
  });

  it("not_due + paid elsewhere → succeeded without sending", async () => {
    await planJobs(sql);
    chain.subs.set(1n, chainSub({ paymentsCount: 2, totalPaid: 10n * E18, remainingCap: 50n * E18, nextBillingAt: T0 + 600n }));
    chain.previews.set(1n, { check: "not_due", amount: 5n * E18 });
    const r = await runScheduler(deps());
    expect(Object.values(r.outcomes)).toContain("succeeded");
    expect(keeper.sent).toHaveLength(0);
    expect((await job()).status).toBe("succeeded");
    // The merchant's own collect log arrives at the indexer afterwards: totals must equal the chain, not double.
    await applyLogs(sql, chain, decoded(collectLog(chain.head + 1n, txHash("merchant-collect"), 1)));
    const s = await sub();
    expect(String(s.total_paid)).toBe((10n * E18).toString());
    expect(String(s.remaining_cap)).toBe((50n * E18).toString());
    expect(await n("payments WHERE status = 'succeeded' AND period_index = 1")).toBe(1);
  });

  it("not_due + unpaid → rescheduled to chain nextBillingAt", async () => {
    chain.subs.set(1n, chainSub({ paymentsCount: 1, nextBillingAt: T0 + 900n }));
    chain.previews.set(1n, { check: "not_due", amount: 5n * E18 });
    await runScheduler(deps());
    const j = await job();
    expect(j.status).toBe("scheduled");
    expect(new Date(j.next_attempt_at as string).getTime()).toBe(Number(T0 + 900n) * 1000);
  });

  it("insufficient balance → retrying (120s, 300s demo delays) → failed_final → past_due → Retry now → recovers", async () => {
    chain.previews.set(1n, { check: "insufficient_balance", amount: 5n * E18 });
    await runScheduler(deps());
    let j = await job();
    expect(j.status).toBe("retrying");
    expect(Number(j.retry_count)).toBe(1);
    expect(new Date(j.next_attempt_at as string).getTime() - now.getTime()).toBe(120_000);
    expect((await sub()).billing_status).toBe("retrying");

    await runScheduler(deps()); // not yet due again
    expect(Number((await job()).retry_count)).toBe(1);

    advance(121);
    await runScheduler(deps());
    j = await job();
    expect(j.status).toBe("retrying");
    expect(new Date(j.next_attempt_at as string).getTime() - now.getTime()).toBe(300_000);

    advance(301);
    await runScheduler(deps());
    j = await job();
    expect(j.status).toBe("failed_final");
    expect(Number(j.retry_count)).toBe(3);
    expect((await sub()).billing_status).toBe("past_due");
    expect(await n("payments WHERE status = 'failed'")).toBe(3);
    expect(await n("notifications WHERE kind = 'past_due'")).toBe(2);
    expect(await n("webhook_events WHERE event_type = 'payment.failed'")).toBe(3);
    expect(await n("webhook_events WHERE event_type = 'subscription.past_due'")).toBe(1);

    advance(3600);
    await runScheduler(deps()); // failed_final is not retried automatically
    expect(keeper.sent).toHaveLength(0);

    // Subscriber funds the wallet and presses "Retry now".
    const [s] = await sql<{ id: string }>`SELECT id FROM subscriptions`;
    expect(await requeueNow(sql, s.id)).toBe(true);
    chain.previews.set(1n, { check: "ok", amount: 5n * E18 });
    chargeOnSend();
    await runScheduler(deps());
    expect((await job()).status).toBe("succeeded");
    expect((await sub()).billing_status).toBe("ok");
  });

  it("duplicate execution after a crash is harmless (no second charge)", async () => {
    chain.previews.set(1n, { check: "ok", amount: 5n * E18 });
    chargeOnSend();
    await planJobs(sql);
    // Simulate: tx was broadcast and mined, but the worker died before persisting anything.
    await keeper.sendCollect(1n, 0);
    await sql`UPDATE billing_jobs SET status = 'processing', locked_by = 'dead', locked_until = ${addSeconds(now, -1)} WHERE period_index = 1`;
    const r = await runScheduler(deps());
    expect(Object.values(r.outcomes)).toContain("succeeded");
    expect(keeper.sent).toHaveLength(1); // the original only
    expect((await job()).status).toBe("succeeded");
    // Index the mined tx (as the indexer would): exactly one payment, totals equal the chain.
    const raw = chain.receipts.get(keeper.sent[0].hash.toLowerCase())!.logs;
    await applyLogs(sql, chain, decoded(...raw));
    await applyLogs(sql, chain, decoded(...raw));
    expect(await n("payments WHERE status = 'succeeded' AND period_index = 1")).toBe(1);
    expect(String((await sub()).total_paid)).toBe((10n * E18).toString());
  });

  it("crash recovery: submitted job with a mined receipt → succeeded", async () => {
    await planJobs(sql);
    const h = txHash("orphan");
    chain.head += 1n;
    chain.addReceipt(h, [collectLog(chain.head, h, 1, 1n, KEEPER)], { from: KEEPER });
    chain.subs.set(1n, chainSub({ paymentsCount: 2, nextBillingAt: T0 + 600n }));
    await sql`UPDATE billing_jobs SET status = 'submitted', tx_hash = ${h}, tx_nonce = 3, last_attempt_at = ${now}, locked_until = ${addSeconds(now, -1)}
              WHERE period_index = 1`;
    const r = await runScheduler(deps());
    expect(Object.values(r.outcomes)).toContain("succeeded");
    expect(await n("payments WHERE status = 'succeeded' AND period_index = 1")).toBe(1);
  });

  it("crash recovery: stuck tx is replaced with the same nonce; dropped tx gets a fresh attempt", async () => {
    await planJobs(sql);
    chain.previews.set(1n, { check: "ok", amount: 5n * E18 });
    chain.nonceLatest = 3; // nonce 3 still unmined
    await sql`UPDATE billing_jobs SET status = 'submitted', tx_hash = ${txHash("stuck")}, tx_nonce = 3, last_attempt_at = ${now}, locked_until = ${addSeconds(now, -1)}
              WHERE period_index = 1`;
    await runScheduler(deps());
    expect(keeper.sent[0]).toMatchObject({ nonce: 3, replacement: true });
    expect((await job()).status).toBe("submitted");

    // Later: nonce 3 consumed by something else, our hash never mined → fresh attempt.
    chain.nonceLatest = 5;
    await sql`UPDATE billing_jobs SET locked_until = ${addSeconds(now, -1)} WHERE period_index = 1`;
    chain.previews.set(1n, { check: "insufficient_allowance", amount: 5n * E18 });
    const r = await runScheduler(deps());
    expect(Object.values(r.outcomes)).toContain("retrying");
  });

  it("RPC errors back off without counting as payment failures; structural checks are skipped", async () => {
    chain.failing.add("previewCollection");
    await runScheduler(deps());
    let j = await job();
    expect(j.status).toBe("retrying");
    expect(String(j.last_error)).toMatch(/^rpc:/);
    expect(Number(j.retry_count)).toBe(0);
    expect(await n("payments WHERE status = 'failed'")).toBe(0);

    chain.failing.clear();
    advance(61);
    chain.previews.set(1n, { check: "not_authorized", amount: 0n });
    await runScheduler(deps());
    j = await job();
    expect(j.status).toBe("skipped");
    expect(j.last_error).toBe("not_authorized");
  });

  it("no keeper key → planning only", async () => {
    const r = await runScheduler({ ...deps(), keeper: null });
    expect(r.keeper).toBeNull();
    expect(r.planned).toBe(1);
    expect(r.claimed).toBe(0);
    expect((await job()).status).toBe("scheduled");
  });
});

describe("releaseLapsed (audit fix: seats of subscriptions that cannot pay are released)", () => {
  it("sends collectDuePayments for a subscription still unpaid one interval after its due date, once", async () => {
    // seedSubscribed: interval 300, nextBillingAt T0+300. Now = T0+301 (due, not lapsed).
    chain.previews.set(1n, { check: "insufficient_balance", amount: 5n * E18 });
    expect((await releaseLapsed(deps())).sent).toBe(0);

    advance(300); // T0+601 >= nextBillingAt + interval
    const r = await releaseLapsed(deps());
    expect(r.sent).toBe(1);
    expect(keeper.batches).toHaveLength(1);
    expect(keeper.batches[0].ids).toEqual([1n]);

    // not resent while the first tx is pending / not yet indexed
    expect((await releaseLapsed(deps())).sent).toBe(0);
  });

  it("does not release a subscription that can pay or is skipped for another reason", async () => {
    advance(300);
    chain.previews.set(1n, { check: "ok", amount: 5n * E18 });
    expect((await releaseLapsed(deps())).sent).toBe(0);
    chain.previews.set(1n, { check: "merchant_inactive", amount: 5n * E18 });
    expect((await releaseLapsed(deps())).sent).toBe(0);
    expect(keeper.batches).toHaveLength(0);
  });
});
