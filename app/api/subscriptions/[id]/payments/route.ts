import type { PaymentDTO } from "@/lib/api-types";
import { requireSession } from "@/lib/server/auth";
import { loadSubscriptionForViewer } from "@/lib/server/access";
import { paymentSelect, toPaymentDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";
import { keeperAddressForDisplay } from "@/lib/server/queries";

export const GET = route<{ id: string }>(async (req, { sql, params }): Promise<PaymentDTO[]> => {
  const session = await requireSession(sql, req);
  const { row } = await loadSubscriptionForViewer(sql, params.id, session.address);
  const keeper = await keeperAddressForDisplay(sql);
  const rows = await sql<Record<string, unknown>>`
    ${paymentSelect(sql)} WHERE pay.subscription_id = ${String(row.id)} ORDER BY pay.created_at DESC LIMIT 500`;
  return rows.map((r) => toPaymentDTO(r, keeper));
});
