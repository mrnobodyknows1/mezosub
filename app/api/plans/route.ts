import type { PlanDTO } from "@/lib/api-types";
import { contracts } from "@/lib/chain/config";
import { requireMerchant } from "@/lib/server/access";
import { planSelect, toPlanDTO } from "@/lib/server/dto";
import { conflict } from "@/lib/server/errors";
import { parseBody, route } from "@/lib/server/http";
import { zCreatePlan } from "@/lib/server/schemas";
import { uniqueSlug } from "@/lib/server/slug";

export const GET = route(async (req, { sql }): Promise<PlanDTO[]> => {
  const { merchant } = await requireMerchant(sql, req);
  const rows = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.merchant_id = ${merchant.id} ORDER BY p.created_at DESC`;
  return rows.map(toPlanDTO);
});

/** Draft row. The terms stored here are exactly what GET /api/plans/:id/chain-params returns for createPlan(). */
export const POST = route(
  async (req, { sql }): Promise<PlanDTO> => {
    const { merchant } = await requireMerchant(sql, req);
    const b = await parseBody(req, zCreatePlan);
    const id = await sql.begin(async (tx) => {
      let slug: string;
      if (b.slug) {
        const [taken] = await tx<{ id: string }>`SELECT id FROM plans WHERE slug = ${b.slug}`;
        if (taken) throw conflict("slug_taken", "That checkout link is already taken");
        slug = b.slug;
      } else slug = await uniqueSlug(tx, "plans", b.name);
      const [row] = await tx<{ id: string }>`
        INSERT INTO plans (merchant_id, slug, name, description, features, visibility, token_address, price, billing_interval,
                           trial_seconds, intro_price, intro_periods, max_subscribers, terms_version, status)
        VALUES (${merchant.id}, ${slug}, ${b.name}, ${b.description}, ${b.features}::jsonb, ${b.visibility}, ${contracts.musd.toLowerCase()},
                ${b.price}::numeric, ${b.billingInterval}, ${b.trialSeconds}, ${b.introPrice}::numeric, ${b.introPeriods},
                ${b.maxSubscribers}, 1, 'draft')
        RETURNING id`;
      return row.id;
    });
    const [row] = await sql<Record<string, unknown>>`${planSelect(sql)} WHERE p.id = ${id}`;
    return toPlanDTO(row);
  },
  { rateLimit: { bucket: "plan_create", limit: 30 }, idempotent: true },
);
