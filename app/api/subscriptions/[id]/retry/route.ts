import type { SubscriptionDetailDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { loadSubscriptionForViewer } from "@/lib/server/access";
import { requeueNow } from "@/lib/server/billing";
import { conflict, notFound } from "@/lib/server/errors";
import { route } from "@/lib/server/http";
import { audit } from "@/lib/server/notify";
import { subscriptionDetail, subscriptionRowById } from "@/lib/server/subscriptions";

/** Re-queue the current retrying / failed_final job for the keeper right now (no chain write here). */
export const POST = route<{ id: string }>(
  async (req, { sql, params }): Promise<SubscriptionDetailDTO> => {
    const session = await requireSession(sql, req);
    const { row } = await loadSubscriptionForViewer(sql, params.id, session.address);
    if (row.status !== "active") throw conflict("not_active", "This subscription is cancelled");
    const ok = await requeueNow(sql, String(row.id));
    if (!ok) throw conflict("nothing_to_retry", "There is no failed payment to retry");
    await audit(sql, session.address, "billing.retry_now", String(row.id));
    const fresh = await subscriptionRowById(sql, String(row.id));
    if (!fresh) throw notFound("Subscription not found");
    return subscriptionDetail(sql, fresh);
  },
  { rateLimit: { bucket: "sub_retry", limit: 5 } },
);
