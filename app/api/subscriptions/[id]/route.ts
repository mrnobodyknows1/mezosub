import type { SubscriptionDetailDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { loadSubscriptionForViewer } from "@/lib/server/access";
import { route } from "@/lib/server/http";
import { subscriptionDetail } from "@/lib/server/subscriptions";

/** :id = DB uuid or on-chain subscription id. Visible to its subscriber or its merchant only. */
export const GET = route<{ id: string }>(async (req, { sql, params }): Promise<SubscriptionDetailDTO> => {
  const session = await requireSession(sql, req);
  const { row } = await loadSubscriptionForViewer(sql, params.id, session.address);
  return subscriptionDetail(sql, row);
});
