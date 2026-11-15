import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/server/env";
import { HttpError, unauthorized } from "@/lib/server/errors";
import { route } from "@/lib/server/http";
import { getKeeper } from "@/lib/server/keeper";
import { runWorkerPass } from "@/lib/server/worker";

// One pass can wait for a keeper receipt; Vercel Hobby allows up to 60 s.
export const maxDuration = 60;

function bearerOk(req: Request): boolean {
  const secret = env.indexerSecret();
  if (!secret) return false;
  const h = req.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * One worker pass, for hosting without a long-running worker (e.g. a free scheduler calling this every minute).
 * Requires `Authorization: Bearer $INDEXER_SECRET`. By default it never signs (indexes, plans jobs, delivers webhooks
 * and notifications). With KEEPER_ON_WEB=true and KEEPER_PRIVATE_KEY set on the web host, it also sends due
 * collections as the keeper. The keeper can only trigger charges that are already due, for the exact amount, to the
 * merchant's own payout; see docs/SECURITY.md.
 */
export const POST = route(
  async (req, { sql }) => {
    if (!env.indexerSecret()) throw new HttpError(503, "disabled", "INDEXER_SECRET is not configured");
    if (!bearerOk(req)) throw unauthorized("Invalid indexer secret");
    const keeper = process.env.KEEPER_ON_WEB === "true" ? getKeeper() : null;
    const result = await runWorkerPass(sql, { workerId: "api-sync", keeper });
    return result;
  },
  { rateLimit: { bucket: "indexer_sync", limit: 20 } },
);
