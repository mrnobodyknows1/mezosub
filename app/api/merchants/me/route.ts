import type { MerchantDTO } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { clock } from "@/lib/server/clock";
import { toMerchantDTO } from "@/lib/server/dto";
import { badRequest } from "@/lib/server/errors";
import { parseBody, route } from "@/lib/server/http";
import { zUpdateMerchant } from "@/lib/server/schemas";
import { validateWebhookUrlShape } from "@/lib/server/webhooks";

export const GET = route(async (req, { sql }): Promise<MerchantDTO> => {
  const { merchant } = await requireMerchant(sql, req);
  return toMerchantDTO(merchant);
});

export const PATCH = route(
  async (req, { sql }): Promise<MerchantDTO> => {
    const { merchant } = await requireMerchant(sql, req);
    const b = await parseBody(req, zUpdateMerchant);
    if (b.webhookUrl) {
      const v = validateWebhookUrlShape(b.webhookUrl);
      if (!v.ok) throw badRequest(`webhookUrl: ${v.reason}`);
    }
    const has = (k: keyof typeof b) => Object.prototype.hasOwnProperty.call(b, k) && b[k] !== undefined;
    const [row] = await sql<Record<string, unknown>>`
      UPDATE merchants SET
        name = CASE WHEN ${has("name")}::boolean THEN ${b.name ?? null} ELSE name END,
        description = CASE WHEN ${has("description")}::boolean THEN ${b.description ?? ""} ELSE description END,
        logo_url = CASE WHEN ${has("logoUrl")}::boolean THEN ${b.logoUrl ?? null} ELSE logo_url END,
        website = CASE WHEN ${has("website")}::boolean THEN ${b.website ?? null} ELSE website END,
        support_email = CASE WHEN ${has("supportEmail")}::boolean THEN ${b.supportEmail ?? null} ELSE support_email END,
        webhook_url = CASE WHEN ${has("webhookUrl")}::boolean THEN ${b.webhookUrl ?? null} ELSE webhook_url END,
        notify_on_payment = CASE WHEN ${has("notifyOnPayment")}::boolean THEN ${b.notifyOnPayment ?? true}::boolean ELSE notify_on_payment END,
        notify_on_failure = CASE WHEN ${has("notifyOnFailure")}::boolean THEN ${b.notifyOnFailure ?? true}::boolean ELSE notify_on_failure END,
        updated_at = ${clock.now()}
      WHERE id = ${merchant.id}
      RETURNING *`;
    return toMerchantDTO(row);
  },
  { rateLimit: { bucket: "merchant_update", limit: 30 } },
);
