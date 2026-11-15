import type { RotateWebhookSecretResponse } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { clock } from "@/lib/server/clock";
import { route } from "@/lib/server/http";
import { audit } from "@/lib/server/notify";
import { generateWebhookSecret } from "@/lib/server/webhooks";

export const POST = route(
  async (req, { sql }): Promise<RotateWebhookSecretResponse> => {
    const { session, merchant } = await requireMerchant(sql, req);
    const secret = generateWebhookSecret();
    await sql`UPDATE merchants SET webhook_secret = ${secret}, updated_at = ${clock.now()} WHERE id = ${merchant.id}`;
    await audit(sql, session.address, "webhook.secret_rotated", merchant.id);
    return { secret };
  },
  { rateLimit: { bucket: "webhook_secret", limit: 10 } },
);
