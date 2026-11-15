import "./setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { contracts } from "@/lib/chain/config";
import { loadSubscriptionForViewer, requireMerchant, requirePlanOfMerchant } from "@/lib/server/access";
import { setChainForTests } from "@/lib/server/chain";
import { clock } from "@/lib/server/clock";
import { confirmPlanTx, syncSubscription } from "@/lib/server/confirm";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { HttpError } from "@/lib/server/errors";
import { E18, FakeChain, MERCHANT, STRANGER, SUBSCRIBER, rawLog, sessionCookieFor, txHash } from "./fakes";
import { T0, planCreatedLogs, seedDraftPlan, seedMerchant, seedSubscribed } from "./scenario";

let sql: Sql;
let chain: FakeChain;
const req = (cookie?: string, init: RequestInit & { url?: string } = {}) =>
  new Request(init.url ?? "http://localhost:3000/api/x", { ...init, headers: { ...(cookie ? { cookie } : {}), ...(init.headers as object) } });
async function code(p: Promise<unknown>) {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof HttpError ? `${e.status}:${e.code}` : String(e);
  }
}

beforeEach(async () => {
  clock.set(() => new Date(Number(T0) * 1000 + 10_000));
  sql = await resetDbForTests();
  chain = new FakeChain();
  setChainForTests(chain);
});

describe("helpers", () => {
  it("requireMerchant: 401 without session, 403 without profile", async () => {
    expect(await code(requireMerchant(sql, req()))).toBe("401:unauthorized");
    expect(await code(requireMerchant(sql, req(await sessionCookieFor(STRANGER))))).toBe("403:forbidden");
    await seedMerchant(sql);
    expect(await code(requireMerchant(sql, req(await sessionCookieFor(MERCHANT))))).toBe("ok");
  });

  it("subscription visible only to its subscriber or merchant", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    expect((await loadSubscriptionForViewer(sql, subRowId, SUBSCRIBER)).role).toBe("subscriber");
    expect((await loadSubscriptionForViewer(sql, "1", MERCHANT)).role).toBe("merchant");
    expect(await code(loadSubscriptionForViewer(sql, subRowId, STRANGER))).toBe("403:forbidden");
    expect(await code(loadSubscriptionForViewer(sql, "nope'; drop", SUBSCRIBER))).toBe("404:not_found");
  });

  it("plans belong to their merchant", async () => {
    const a = await seedMerchant(sql);
    const b = await seedMerchant(sql, STRANGER, "other");
    const plan = await seedDraftPlan(sql, a);
    expect(await code(requirePlanOfMerchant(sql, plan, b))).toBe("403:forbidden");
  });
});

describe("plan confirm", () => {
  async function registered() {
    const merchantRowId = await seedMerchant(sql);
    await sql`UPDATE merchants SET onchain_merchant_id = 1, chain_status = 'active' WHERE id = ${merchantRowId}`;
    const [m] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE id = ${merchantRowId}`;
    return m as Record<string, unknown> & { id: string; wallet_address: string; onchain_merchant_id: string; chain_status: string };
  }

  it("links when terms match", async () => {
    const m = await registered();
    const planId = await seedDraftPlan(sql, m.id);
    const { hash, logs } = planCreatedLogs();
    chain.addReceipt(hash, logs, { from: MERCHANT });
    chain.plans.set(1n, { merchantId: 1n, token: contracts.musd, amount: 5n * E18, introAmount: 0n, interval: 300, trialPeriod: 0, introPeriods: 0, maxSubscribers: 0, activeSubscribers: 0, termsVersion: 1, status: 1, createdAt: 0n });
    const [plan] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${planId}`;
    const row = await confirmPlanTx(sql, chain, m, plan, MERCHANT, hash);
    expect(String(row.onchain_plan_id)).toBe("1");
  });

  it("rejects mismatched terms and saves the chain truth separately", async () => {
    const m = await registered();
    const planId = await seedDraftPlan(sql, m.id);
    const { hash, logs } = planCreatedLogs(3n, { amount: 9n * E18 });
    chain.addReceipt(hash, logs, { from: MERCHANT });
    const [plan] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${planId}`;
    expect(await code(confirmPlanTx(sql, chain, m, plan, MERCHANT, hash))).toBe("409:terms_mismatch");
    const [draft] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${planId}`;
    expect(draft.onchain_plan_id).toBeNull();
    const [truth] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE onchain_plan_id = 1`;
    expect(String(truth.price)).toBe((9n * E18).toString());
  });

  it("rejects a PlanCreated of another merchant and a tx from another wallet", async () => {
    const m = await registered();
    const planId = await seedDraftPlan(sql, m.id);
    const [plan] = await sql<Record<string, unknown>>`SELECT * FROM plans WHERE id = ${planId}`;
    const other = planCreatedLogs(3n, { merchantId: 2n });
    chain.addReceipt(other.hash, other.logs, { from: MERCHANT });
    expect(await code(confirmPlanTx(sql, chain, m, plan, MERCHANT, other.hash))).toBe("403:forbidden");
    const mine = planCreatedLogs(3n);
    chain.addReceipt(mine.hash, mine.logs, { from: STRANGER });
    expect(await code(confirmPlanTx(sql, chain, m, plan, MERCHANT, mine.hash))).toBe("403:wrong_sender");
  });
});

describe("subscription sync", () => {
  it("rejects a tx for another subscription", async () => {
    await seedSubscribed(sql, chain);
    const h = txHash();
    chain.addReceipt(h, [rawLog("manager", "SubscriptionCancelled", { subscriptionId: 99n, cancelledBy: SUBSCRIBER, cancelledAt: T0 }, { blockNumber: 9n, txHash: h, logIndex: 0 })]);
    expect(await code(syncSubscription(sql, chain, 1n, SUBSCRIBER, h))).toBe("422:wrong_subscription");
  });
});

describe("routes", () => {
  it("POST/GET /api/plans, Idempotency-Key replay, other merchant forbidden", async () => {
    const plansRoute = await import("@/app/api/plans/route");
    const planRoute = await import("@/app/api/plans/[id]/route");
    const cookie = await sessionCookieFor(MERCHANT);
    expect((await plansRoute.POST(req(cookie, { method: "POST", body: "{}" }))).status).toBe(403); // no profile yet
    await seedMerchant(sql);
    const body = JSON.stringify({ name: "Pro Plan", price: "4.99", billingInterval: 300, features: ["A"] });
    const headers = { "idempotency-key": "k1", "content-type": "application/json" };
    const r1 = await plansRoute.POST(req(cookie, { method: "POST", body, headers }));
    expect(r1.status).toBe(200);
    const dto = await r1.json();
    expect(dto).toMatchObject({ name: "Pro Plan", slug: "pro-plan", price: "4990000000000000000", status: "draft", intervalLabel: "Every 5 minutes (testnet demo)" });
    expect(dto.checkoutUrl).toBe("http://localhost:3000/subscribe/pro-plan");
    const r2 = await plansRoute.POST(req(cookie, { method: "POST", body, headers }));
    expect((await r2.json()).id).toBe(dto.id); // replayed
    const r3 = await plansRoute.POST(req(cookie, { method: "POST", body, headers: { "idempotency-key": "k2" } }));
    expect((await r3.json()).slug).toBe("pro-plan-2");
    const bad = await plansRoute.POST(req(cookie, { method: "POST", body: JSON.stringify({ name: "X1", price: "1", billingInterval: 123 }) }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("validation_error");
    const list = await (await plansRoute.GET(req(cookie))).json();
    expect(list).toHaveLength(2);

    await seedMerchant(sql, STRANGER, "stranger");
    const strangerCookie = await sessionCookieFor(STRANGER);
    const res = await planRoute.GET(req(strangerCookie), { params: Promise.resolve({ id: dto.id }) });
    expect(res.status).toBe(403);
  });

  it("cross-site POST is blocked; session route works", async () => {
    const plansRoute = await import("@/app/api/plans/route");
    const sessionRoute = await import("@/app/api/auth/session/route");
    const cookie = await sessionCookieFor(MERCHANT);
    const r = await plansRoute.POST(req(cookie, { method: "POST", body: "{}", headers: { origin: "https://evil.example", host: "localhost:3000" } }));
    expect(r.status).toBe(403);
    const s = await (await sessionRoute.GET(req(cookie))).json();
    expect(s).toEqual({ address: MERCHANT.toLowerCase(), merchant: null });
  });

  it("GET /api/subscriptions/:id enforces viewer; detail DTO shape", async () => {
    const { subRowId } = await seedSubscribed(sql, chain);
    const route = await import("@/app/api/subscriptions/[id]/route");
    const ok = await route.GET(req(await sessionCookieFor(SUBSCRIBER)), { params: Promise.resolve({ id: subRowId }) });
    expect(ok.status).toBe(200);
    const d = await ok.json();
    expect(d).toMatchObject({ onchainSubscriptionId: "1", status: "active", state: "active", periodsCovered: 11, paymentsCount: 1, billingStatus: "ok" });
    expect(d.payments).toHaveLength(1);
    expect(d.payments[0].collectorKind).toBe("subscriber");
    const no = await route.GET(req(await sessionCookieFor(STRANGER)), { params: Promise.resolve({ id: subRowId }) });
    expect(no.status).toBe(403);
  });
});
