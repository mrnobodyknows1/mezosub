import type { MerchantDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { merchantForAddress } from "@/lib/server/access";
import { toMerchantDTO } from "@/lib/server/dto";
import { parseBody, route } from "@/lib/server/http";
import { ensureUser } from "@/lib/server/indexer";
import { zCreateMerchant } from "@/lib/server/schemas";
import { uniqueSlug } from "@/lib/server/slug";

/** Create the off-chain (pending) profile. Idempotent per wallet: returns the existing profile if present. */
export const POST = route(
  async (req, { sql }): Promise<MerchantDTO> => {
    const session = await requireSession(sql, req);
    const body = await parseBody(req, zCreateMerchant);
    const existing = await merchantForAddress(sql, session.address);
    if (existing) return toMerchantDTO(existing);
    const row = await sql.begin(async (tx) => {
      const userId = await ensureUser(tx, session.address);
      const slug = await uniqueSlug(tx, "merchants", body.name);
      const [m] = await tx<Record<string, unknown>>`
        INSERT INTO merchants (owner_user_id, wallet_address, name, slug, description, logo_url, website, support_email)
        VALUES (${userId}, ${session.address}, ${body.name}, ${slug}, ${body.description ?? ""}, ${body.logoUrl ?? null},
                ${body.website ?? null}, ${body.supportEmail ?? null})
        ON CONFLICT (wallet_address) DO NOTHING
        RETURNING *`;
      return m ?? (await merchantForAddress(tx, session.address));
    });
    return toMerchantDTO(row!);
  },
  { rateLimit: { bucket: "merchant_create", limit: 10 }, idempotent: true },
);
