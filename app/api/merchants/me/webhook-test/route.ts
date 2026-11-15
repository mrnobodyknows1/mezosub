import { randomUUID } from "node:crypto";
import { requireMerchant } from "@/lib/server/access";
import { clock } from "@/lib/server/clock";
import { badRequest } from "@/lib/server/errors";
import { route } from "@/lib/server/http";
import { enqueueWebhook } from "@/lib/server/notify";

/** Queue a `ping` webhook; the worker delivers it on its next pass. */
export const POST = route(
  async (req, { sql }) => {
    const { merchant } = await requireMerchant(sql, req);
    if (!merchant.webhook_url) throw badRequest("Set a webhook URL first");
    if (!merchant.webhook_secret) throw badRequest("Generate a webhook secret first");
    const key = `ping:${merchant.id}:${randomUUID()}`;
    await enqueueWebhook(sql, { merchantId: merchant.id, type: "ping", dedupeKey: key, data: { message: "Hello from MezoSub", at: clock.now().toISOString() } });
    const [row] = await sql<{ id: string }>`SELECT id FROM webhook_events WHERE dedupe_key = ${key}`;
    return { ok: true, id: row?.id ?? null };
  },
  { rateLimit: { bucket: "webhook_test", limit: 10 } },
);
