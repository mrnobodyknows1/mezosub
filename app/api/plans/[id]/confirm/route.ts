import type { PlanDTO } from "@/lib/api-types";
import { requireMerchant, requirePlanOfMerchant } from "@/lib/server/access";
import { getChain } from "@/lib/server/chain";
import { confirmPlanTx } from "@/lib/server/confirm";
import { planSelect, toPlanDTO } from "@/lib/server/dto";
import { parseBody, route, zConfirm } from "@/lib/server/http";

/** {txHash} of createPlan / updatePlan / pausePlan / resumePlan / archivePlan for this plan. */
export const POST = route<{ id: string }>(
  async (req, { sql, params }): Promise<PlanDTO> => {
    const { session, merchant } = await requireMerchant(sql, req);
    const plan = await requirePlanOfMerchant(sql, params.id, merchant.id);
    const { txHash } = await parseBody(req, zConfirm);
    await confirmPlanTx(sql, getChain(), merchant, plan, session.address, txHash);
    const [row] = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.id = ${params.id}`;
    return toPlanDTO(row);
  },
  { rateLimit: { bucket: "plan_confirm", limit: 30 }, idempotent: true },
);
