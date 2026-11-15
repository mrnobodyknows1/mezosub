import { z } from "zod";
import type { Paginated, PaymentDTO } from "@/lib/api-types";
import { requireMerchant } from "@/lib/server/access";
import { paymentSelect, toPaymentDTO } from "@/lib/server/dto";
import { parseQuery, route, zPage, zPageSize } from "@/lib/server/http";
import { keeperAddressForDisplay } from "@/lib/server/queries";

const q = z.object({
  page: zPage,
  pageSize: zPageSize,
  status: z.enum(["succeeded", "failed", "refunded", "all", ""]).optional(),
});

export const GET = route(async (req, { sql }): Promise<Paginated<PaymentDTO>> => {
  const { merchant } = await requireMerchant(sql, req);
  const { page, pageSize, status } = parseQuery(req, q);
  const filter = status && status !== "all" ? sql.frag`AND pay.status = ${status}` : sql.frag``;
  const [{ n }] = await sql<{ n: number }>`SELECT count(*)::int AS n FROM payments pay WHERE pay.merchant_id = ${merchant.id} ${filter}`;
  const keeper = await keeperAddressForDisplay(sql);
  const rows = await sql<Record<string, unknown>>`
    ${paymentSelect(sql)} WHERE pay.merchant_id = ${merchant.id} ${filter}
    ORDER BY COALESCE(pay.paid_at, pay.created_at) DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`;
  return { items: rows.map((r) => toPaymentDTO(r, keeper)), total: Number(n), page, pageSize };
});
