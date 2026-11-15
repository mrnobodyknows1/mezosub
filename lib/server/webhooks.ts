// Merchant webhook delivery: at-least-once, HMAC-SHA256 signed, SSRF-guarded.
// Header: X-MezoSub-Signature: t=<unix>,v1=<hex hmac_sha256(secret, `${t}.${body}`)>

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpsRequest } from "node:https";
import type { Sql } from "./db";
import { int, json } from "./db/rows";
import { addSeconds, clock } from "./clock";

export const WEBHOOK_MAX_ATTEMPTS = 5;
export const WEBHOOK_TIMEOUT_MS = 5000;
const BASE_BACKOFF_SECONDS = 30;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export function signWebhook(secret: string, body: string, t: number = Math.floor(clock.now().getTime() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

/** Reference verifier for merchants (and tests). Rejects timestamps older than `toleranceSec`. */
export function verifyWebhookSignature(secret: string, body: string, header: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest();
  const got = Buffer.from(parts.v1, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Exponential backoff after `attempts` failed deliveries: 30s, 60s, 120s, 240s. */
export function webhookBackoffSeconds(attempts: number): number {
  return BASE_BACKOFF_SECONDS * 2 ** Math.max(0, attempts - 1);
}

// ---------------------------------------------------------------- SSRF guard

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}
function inV4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/");
  const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}
const V4_BLOCKED = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24",
  "192.0.2.0/24", "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
  "224.0.0.0/4", "240.0.0.0/4", "255.255.255.255/32",
];

export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return V4_BLOCKED.some((c) => inV4(ip, c));
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateIp(mapped[1]);
    if (/^::ffff:/.test(x)) return true; // hex-form mapped addresses: refuse
    if (/^f[cd]/.test(x)) return true; // fc00::/7 ULA
    if (/^fe[89ab]/.test(x)) return true; // fe80::/10 link-local
    if (/^ff/.test(x)) return true; // multicast
    if (/^(64:ff9b|2001:db8|2001:0?:|2002:)/.test(x)) return true; // NAT64 / docs / Teredo / 6to4
    return false;
  }
  return true;
}

/** Synchronous shape check used when a merchant saves a URL. */
export function validateWebhookUrlShape(raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "Webhook URL must use https" };
  if (url.username || url.password) return { ok: false, reason: "Credentials in the URL are not allowed" };
  if (url.port && url.port !== "443") return { ok: false, reason: "Only the default https port is allowed" };
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { ok: false, reason: "Webhook host must be a public hostname" };
  }
  if (isIP(host) && isPrivateIp(host)) return { ok: false, reason: "Webhook host resolves to a private address" };
  return { ok: true, url };
}

/** Full check at delivery time: shape + every DNS answer must be public. */
export async function assertPublicWebhookUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((a) => a.address),
): Promise<URL> {
  const shape = validateWebhookUrlShape(raw);
  if (!shape.ok) throw new Error(shape.reason);
  const host = shape.url.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0 || addrs.some(isPrivateIp)) throw new Error("Webhook host resolves to a private address");
  return shape.url;
}

// ---------------------------------------------------------------- pinned transport (no DNS-rebinding window)

/**
 * dns.lookup replacement handed to https.request: every answer is checked at CONNECT time, so the address that
 * was validated is the address that is dialled (a second, unchecked resolution never happens).
 */
export function safeLookup(
  hostname: string,
  options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
): void {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err, "", 0);
    const list = addrs as LookupAddress[];
    if (list.length === 0 || list.some((a) => isPrivateIp(a.address))) {
      const e = new Error("Webhook host resolves to a private address") as NodeJS.ErrnoException;
      e.code = "EPRIVATEADDR";
      return cb(e, "", 0);
    }
    if (options?.all) return cb(null, list);
    cb(null, list[0].address, list[0].family);
  });
}

/** Minimal fetch-compatible POST over https with the pinned lookup, no redirects, hard timeout. */
export const pinnedFetch = ((input: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  new Promise<{ status: number }>((resolve, reject) => {
    const req = httpsRequest(
      input,
      { method: init.method ?? "POST", headers: init.headers, lookup: safeLookup as never, signal: init.signal },
      (res) => {
        res.resume(); // drain; body is ignored
        res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  })) as unknown as typeof fetch;

// ---------------------------------------------------------------- delivery

export interface DeliverDeps {
  fetchImpl?: typeof fetch;
  resolve?: (host: string) => Promise<string[]>;
}

export async function deliverPendingWebhooks(sql: Sql, deps: DeliverDeps = {}, limit = 20): Promise<{ delivered: number; failed: number; retried: number }> {
  const fetchImpl = deps.fetchImpl ?? pinnedFetch;
  const now = clock.now();
  const rows = await sql<Record<string, unknown>>`
    SELECT w.id, w.event_type, w.payload, w.attempts, m.webhook_url, m.webhook_secret
    FROM webhook_events w JOIN merchants m ON m.id = w.merchant_id
    WHERE w.status = 'pending' AND w.next_attempt_at <= ${now}
    ORDER BY w.next_attempt_at ASC LIMIT ${limit}`;
  const res = { delivered: 0, failed: 0, retried: 0 };
  for (const r of rows) {
    const id = String(r.id);
    const url = r.webhook_url ? String(r.webhook_url) : null;
    const secret = r.webhook_secret ? String(r.webhook_secret) : null;
    if (!url || !secret) {
      await sql`UPDATE webhook_events SET status = 'skipped', last_error = ${!url ? "no webhook url" : "webhook secret not set"},
                processed_at = ${now} WHERE id = ${id}`;
      continue;
    }
    const body = JSON.stringify(json<Record<string, unknown>>(r.payload, {}));
    const attempts = int(r.attempts) + 1;
    let status: number | null = null;
    let error: string | null = null;
    try {
      const target = await assertPublicWebhookUrl(url, deps.resolve);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        const resp = await fetchImpl(target.toString(), {
          method: "POST",
          redirect: "manual", // never follow redirects (SSRF)
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            "user-agent": "MezoSub-Webhooks/1",
            "x-mezosub-event": String(r.event_type),
            "x-mezosub-delivery": id,
            "x-mezosub-signature": signWebhook(secret, body),
          },
          body,
        });
        status = resp.status;
        if (resp.status < 200 || resp.status >= 300) error = `HTTP ${resp.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = (e as Error).name === "AbortError" ? "timeout" : (e as Error).message.slice(0, 200);
    }
    if (!error) {
      await sql`UPDATE webhook_events SET status = 'delivered', attempts = ${attempts}, last_status_code = ${status}, last_error = NULL,
                processed_at = ${clock.now()} WHERE id = ${id}`;
      res.delivered++;
    } else if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      await sql`UPDATE webhook_events SET status = 'failed', attempts = ${attempts}, last_status_code = ${status}, last_error = ${error},
                processed_at = ${clock.now()} WHERE id = ${id}`;
      res.failed++;
    } else {
      await sql`UPDATE webhook_events SET attempts = ${attempts}, last_status_code = ${status}, last_error = ${error},
                next_attempt_at = ${addSeconds(clock.now(), webhookBackoffSeconds(attempts))} WHERE id = ${id}`;
      res.retried++;
    }
  }
  return res;
}
