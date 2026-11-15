import "./setup-env";
import { beforeEach, describe, expect, it } from "vitest";
import { clock } from "@/lib/server/clock";
import { resetDbForTests, type Sql } from "@/lib/server/db";
import { ensureUser } from "@/lib/server/indexer";
import { enqueueWebhook } from "@/lib/server/notify";
import {
  assertPublicWebhookUrl, deliverPendingWebhooks, isPrivateIp, signWebhook, validateWebhookUrlShape, verifyWebhookSignature, WEBHOOK_MAX_ATTEMPTS,
} from "@/lib/server/webhooks";
import { MERCHANT } from "./fakes";

let sql: Sql;
let merchantId: string;
const publicDns = async () => ["93.184.216.34"];

beforeEach(async () => {
  clock.set(null);
  sql = await resetDbForTests();
  const uid = await ensureUser(sql, MERCHANT);
  const [m] = await sql<{ id: string }>`
    INSERT INTO merchants (owner_user_id, wallet_address, name, slug, webhook_url, webhook_secret)
    VALUES (${uid}, ${MERCHANT.toLowerCase()}, 'Shop', 'shop', 'https://hooks.example.com/mezosub', 'whsec_test') RETURNING id`;
  merchantId = m.id;
});

describe("webhook signing", () => {
  it("signs t.body with HMAC-SHA256 and verifies", () => {
    const body = JSON.stringify({ id: "1", type: "ping" });
    const h = signWebhook("secret", body, 1_700_000_000);
    expect(h).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhookSignature("secret", body, h, 300, 1_700_000_100)).toBe(true);
    expect(verifyWebhookSignature("secret", body + " ", h, 300, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature("other", body, h, 300, 1_700_000_100)).toBe(false);
    expect(verifyWebhookSignature("secret", body, h, 300, 1_700_001_000)).toBe(false); // stale
  });
});

describe("SSRF guard", () => {
  it("blocks private / non-https targets", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "0.0.0.0"])
      expect(isPrivateIp(ip)).toBe(true);
    expect(isPrivateIp("93.184.216.34")).toBe(false);
    expect(validateWebhookUrlShape("http://example.com").ok).toBe(false);
    expect(validateWebhookUrlShape("https://localhost/x").ok).toBe(false);
    expect(validateWebhookUrlShape("https://10.0.0.1/x").ok).toBe(false);
    expect(validateWebhookUrlShape("https://user:pw@example.com").ok).toBe(false);
    expect(validateWebhookUrlShape("https://example.com:8443/x").ok).toBe(false);
    await expect(assertPublicWebhookUrl("https://rebind.example.com", async () => ["10.0.0.5"])).rejects.toThrow(/private/);
    await expect(assertPublicWebhookUrl("https://ok.example.com", publicDns)).resolves.toBeInstanceOf(URL);
  });
});

describe("delivery", () => {
  it("delivers signed payloads", async () => {
    await enqueueWebhook(sql, { merchantId, type: "ping", dedupeKey: "ping:1", data: { a: 1 } });
    await enqueueWebhook(sql, { merchantId, type: "ping", dedupeKey: "ping:1", data: { a: 1 } }); // deduped
    const seen: { headers: Headers; body: string; redirect?: string }[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push({ headers: new Headers(init.headers), body: String(init.body), redirect: init.redirect });
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    const r = await deliverPendingWebhooks(sql, { fetchImpl, resolve: publicDns });
    expect(r.delivered).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].redirect).toBe("manual");
    const sig = seen[0].headers.get("x-mezosub-signature")!;
    expect(verifyWebhookSignature("whsec_test", seen[0].body, sig)).toBe(true);
    const payload = JSON.parse(seen[0].body);
    expect(payload).toMatchObject({ type: "ping", data: { a: 1 } });
    expect(typeof payload.id).toBe("string");
  });

  it("retries with exponential backoff, then fails after 5 attempts; private DNS never fetched", async () => {
    await enqueueWebhook(sql, { merchantId, type: "ping", dedupeKey: "ping:2", data: {} });
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return new Response("no", { status: 500 });
    }) as unknown as typeof fetch;
    let t = Date.now();
    clock.set(() => new Date(t));
    const gaps: number[] = [];
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      await deliverPendingWebhooks(sql, { fetchImpl, resolve: publicDns });
      const [w] = await sql<{ next_attempt_at: Date; status: string }>`SELECT next_attempt_at, status FROM webhook_events WHERE dedupe_key = 'ping:2'`;
      if (w.status === "pending") {
        gaps.push(Math.round((new Date(w.next_attempt_at).getTime() - t) / 1000));
        t = new Date(w.next_attempt_at).getTime();
      }
    }
    expect(calls).toBe(5);
    expect(gaps).toEqual([30, 60, 120, 240]);
    const [w] = await sql<{ status: string; attempts: number }>`SELECT status, attempts FROM webhook_events WHERE dedupe_key = 'ping:2'`;
    expect(w.status).toBe("failed");
    expect(Number(w.attempts)).toBe(5);

    await enqueueWebhook(sql, { merchantId, type: "ping", dedupeKey: "ping:3", data: {} });
    let fetched = 0;
    await deliverPendingWebhooks(sql, { fetchImpl: (async () => (fetched++, new Response("ok"))) as unknown as typeof fetch, resolve: async () => ["127.0.0.1"] });
    expect(fetched).toBe(0);
  });
});
