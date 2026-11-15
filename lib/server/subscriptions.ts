import type { SubscriptionDetailDTO } from "@/lib/api-types";
import type { Sql } from "./db";
import { jobSelect, paymentSelect, subscriptionSelect, toBillingJobDTO, toPaymentDTO, toSubscriptionDTO } from "./dto";
import { keeperAddressForDisplay } from "./queries";

export async function subscriptionRowById(sql: Sql, id: string): Promise<Record<string, unknown> | null> {
  const [row] = await sql<Record<string, unknown>>`${subscriptionSelect(sql)} WHERE s.id = ${id}`;
  return row ?? null;
}

export async function subscriptionDetail(sql: Sql, row: Record<string, unknown>): Promise<SubscriptionDetailDTO> {
  const id = String(row.id);
  const keeper = await keeperAddressForDisplay(sql);
  const payments = await sql<Record<string, unknown>>`
    ${paymentSelect(sql)} WHERE pay.subscription_id = ${id} ORDER BY pay.created_at DESC LIMIT 200`;
  const jobs = await sql<Record<string, unknown>>`
    ${jobSelect(sql)} WHERE j.subscription_id = ${id} ORDER BY j.period_index DESC, j.updated_at DESC LIMIT 50`;
  return { ...toSubscriptionDTO(row), payments: payments.map((p) => toPaymentDTO(p, keeper)), jobs: jobs.map(toBillingJobDTO) };
}
