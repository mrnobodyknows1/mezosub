import type { SessionResponse } from "@/lib/api-types";
import { sessionFromRequest } from "@/lib/server/auth";
import { merchantForAddress } from "@/lib/server/access";
import { toMerchantDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";

export const GET = route(async (req, { sql }): Promise<SessionResponse> => {
  const s = await sessionFromRequest(sql, req);
  if (!s) return { address: null, merchant: null };
  const m = await merchantForAddress(sql, s.address);
  return { address: s.address, merchant: m ? toMerchantDTO(m) : null };
});
