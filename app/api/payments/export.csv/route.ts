import { musdToDecimalString } from "@/lib/money";
import { requireMerchant } from "@/lib/server/access";
import { paymentSelect, toPaymentDTO } from "@/lib/server/dto";
import { route } from "@/lib/server/http";
import { csvCell, keeperAddressForDisplay } from "@/lib/server/queries";

/** All payments of the merchant as CSV (cells are formula-injection safe). */
export const GET = route(
  async (req, { sql }) => {
    const { merchant } = await requireMerchant(sql, req);
    const keeper = await keeperAddressForDisplay(sql);
    const rows = await sql<Record<string, unknown>>`
      ${paymentSelect(sql)} WHERE pay.merchant_id = ${merchant.id} ORDER BY COALESCE(pay.paid_at, pay.created_at) DESC LIMIT 50000`;
    const header = [
      "payment_id", "date", "status", "plan", "subscriber", "subscription_id", "period", "amount_musd", "amount_wei",
      "attempt", "failure_reason", "collector", "collector_kind", "tx_hash", "explorer_url",
    ];
    const lines = [header.join(",")];
    for (const r of rows) {
      const p = toPaymentDTO(r, keeper);
      lines.push(
        [
          p.id, p.paidAt ?? p.createdAt, p.status, p.planName, p.subscriberAddress, p.onchainSubscriptionId, p.periodIndex,
          musdToDecimalString(p.amount), p.amount, p.attemptNumber, p.failureReason, p.collector, p.collectorKind,
          p.transactionHash, p.explorerUrl,
        ].map(csvCell).join(","),
      );
    }
    const name = `mezosub-payments-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(lines.join("\r\n") + "\r\n", {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  },
  { rateLimit: { bucket: "payments_csv", limit: 10 } },
);
