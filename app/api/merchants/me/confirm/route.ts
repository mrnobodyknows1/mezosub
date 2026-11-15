import type { MerchantDTO } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { getChain } from "@/lib/server/chain";
import { confirmMerchantTx } from "@/lib/server/confirm";
import { toMerchantDTO } from "@/lib/server/dto";
import { parseBody, route, zConfirm } from "@/lib/server/http";

/** {txHash} of registerMerchant / setPayout / setKeeperEnabled / pauseMerchant / resumeMerchant. */
export const POST = route(
  async (req, { sql }): Promise<MerchantDTO> => {
    const { session, merchant } = await requireMerchant(sql, req);
    const { txHash } = await parseBody(req, zConfirm);
    return toMerchantDTO(await confirmMerchantTx(sql, getChain(), merchant, session.address, txHash));
  },
  { rateLimit: { bucket: "merchant_confirm", limit: 30 }, idempotent: true },
);
