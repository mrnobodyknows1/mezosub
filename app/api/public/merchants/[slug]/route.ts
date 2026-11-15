import type { PlanDTO, PublicMerchantDTO } from "@/lib/api-types";
import { planSelect, toPublicPlanDTO, toPublicMerchantDTO } from "@/lib/server/dto";
import { notFound } from "@/lib/server/errors";
import { route } from "@/lib/server/http";

/** Response: { merchant: PublicMerchantDTO; plans: PlanDTO[] } — public, active, on-chain plans only. */
export const GET = route<{ slug: string }>(
  async (_req, { sql, params }): Promise<{ merchant: PublicMerchantDTO; plans: PlanDTO[] }> => {
    const slug = String(params.slug || "").toLowerCase();
    if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw notFound("Merchant not found");
    const [m] = await sql<Record<string, unknown>>`SELECT * FROM merchants WHERE slug = ${slug}`;
    if (!m) throw notFound("Merchant not found");
    const plans = await sql<Record<string, unknown>>`
      ${planSelect(sql)} WHERE p.merchant_id = ${String(m.id)} AND p.visibility = 'public' AND p.status = 'active'
        AND p.onchain_plan_id IS NOT NULL
      ORDER BY p.price ASC`;
    return { merchant: toPublicMerchantDTO(m), plans: plans.map(toPublicPlanDTO) };
  },
  { rateLimit: { bucket: "public_merchant", limit: 120 } },
);
