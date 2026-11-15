import type { SubscriptionDTO } from "@/lib/api-types";
import { getChain } from "@/lib/server/chain";
import { confirmSubscribeTx } from "@/lib/server/confirm";
import { subscriptionSelect, toSubscriptionDTO } from "@/lib/server/dto";
import { HttpError } from "@/lib/server/errors";
import { parseBody, route, zConfirm } from "@/lib/server/http";

/** Public (rate-limited): {txHash} of subscribe / subscribeWithPermit → verified Subscribed log → SubscriptionDTO. */
export const POST = route(
  async (req, { sql }): Promise<SubscriptionDTO> => {
    const { txHash } = await parseBody(req, zConfirm);
    const ids = await confirmSubscribeTx(sql, getChain(), txHash);
    const [row] = await sql<Record<string, unknown>>`${subscriptionSelect(sql)} WHERE s.onchain_subscription_id = ${ids[0]}`;
    if (!row) throw new HttpError(500, "sync_failed", "Subscription confirmed on-chain but could not be saved; it will appear shortly");
    return toSubscriptionDTO(row);
  },
  { rateLimit: { bucket: "sub_confirm", limit: 30 }, idempotent: true },
);
