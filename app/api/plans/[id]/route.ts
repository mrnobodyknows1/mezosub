import type { PlanDTO } from "@/lib/api-types";
import { requireMerchant, requirePlanOfMerchant } from "@/lib/server/access";
import { clock } from "@/lib/server/clock";
import { planSelect, toPlanDTO } from "@/lib/server/dto";
import { parseBody, route } from "@/lib/server/http";
import { zUpdatePlanMeta } from "@/lib/server/schemas";

type P = { id: string };

export const GET = route<P>(async (req, { sql, params }): Promise<PlanDTO> => {
  const { merchant } = await requireMerchant(sql, req);
  await requirePlanOfMerchant(sql, params.id, merchant.id);
  const [row] = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.id = ${params.id}`;
  return toPlanDTO(row);
});

/** Metadata only; term changes go through updatePlan() on-chain + POST /api/plans/:id/confirm. */
export const PATCH = route<P>(
  async (req, { sql, params }): Promise<PlanDTO> => {
    const { merchant } = await requireMerchant(sql, req);
    await requirePlanOfMerchant(sql, params.id, merchant.id);
    const b = await parseBody(req, zUpdatePlanMeta);
    await sql`
      UPDATE plans SET
        name = COALESCE(${b.name ?? null}, name),
        description = COALESCE(${b.description ?? null}, description),
        features = COALESCE(${b.features ?? null}::jsonb, features),
        visibility = COALESCE(${b.visibility ?? null}, visibility),
        updated_at = ${clock.now()}
      WHERE id = ${params.id}`;
    const [row] = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.id = ${params.id}`;
    return toPlanDTO(row);
  },
  { rateLimit: { bucket: "plan_update", limit: 60 } },
);
