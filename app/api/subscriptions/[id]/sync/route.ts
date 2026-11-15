import { z } from "zod";
import type { SubscriptionDetailDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { loadSubscriptionForViewer } from "@/lib/server/access";
import { getChain } from "@/lib/server/chain";
import { syncSubscription } from "@/lib/server/confirm";
import { big } from "@/lib/server/db/rows";
import { notFound } from "@/lib/server/errors";
import { parseBody, route, zTxHash } from "@/lib/server/http";
import { subscriptionDetail, subscriptionRowById } from "@/lib/server/subscriptions";

/** {txHash?} of collectPayment / cancelSubscription / revokeAuthorization / updateAuthorization / refund → verify + re-read chain. */
export const POST = route<{ id: string }>(
  async (req, { sql, params }): Promise<SubscriptionDetailDTO> => {
    const session = await requireSession(sql, req);
    const { row } = await loadSubscriptionForViewer(sql, params.id, session.address);
    const { txHash } = await parseBody(req, z.object({ txHash: zTxHash.optional() }));
    await syncSubscription(sql, getChain(), big(row.onchain_subscription_id), session.address, txHash);
    const fresh = await subscriptionRowById(sql, String(row.id));
    if (!fresh) throw notFound("Subscription not found");
    return subscriptionDetail(sql, fresh);
  },
  { rateLimit: { bucket: "sub_sync", limit: 30 }, idempotent: true },
);
