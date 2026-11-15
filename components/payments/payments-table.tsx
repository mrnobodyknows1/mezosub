import type { PaymentDTO } from "@/lib/api-types";
import { formatDateTime, shortAddress } from "@/lib/client/format";
import { reasonText } from "@/lib/client/errors";
import { PAYMENT_STATUS } from "@/lib/client/status";
import { Musd } from "@/components/shared/money";
import { StatusBadge } from "@/components/shared/status-badge";
import { TxLink } from "@/components/shared/address";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type Column = "subscriber" | "plan" | "merchant";

function txOf(p: PaymentDTO) {
  return p.transactionHash ? <TxLink hash={p.transactionHash} /> : <span className="text-muted-foreground">--</span>;
}

function statusOf(p: PaymentDTO) {
  return (
    <div className="flex flex-col">
      <StatusBadge meta={PAYMENT_STATUS[p.status]} />
      {p.status === "failed" && p.failureReason ? (
        <span className="text-xs text-muted-foreground">
          {reasonText(p.failureReason)}
          {p.attemptNumber > 1 ? `, attempt ${p.attemptNumber}` : ""}
        </span>
      ) : null}
    </div>
  );
}

const COLLECTOR: Record<string, string> = { merchant: "Merchant", keeper: "Keeper", subscriber: "Subscriber", unknown: "Other" };

/**
 * Payment history. Table on ≥ md, stacked rows on mobile (no horizontal scroll).
 * `columns` picks the context columns: merchant views show subscriber + plan, subscriber views show merchant + plan.
 */
export function PaymentsTable({ payments, columns = ["subscriber", "plan"] }: { payments: PaymentDTO[]; columns?: Column[] }) {
  const show = (c: Column) => columns.includes(c);
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              {show("merchant") ? <TableHead>Merchant</TableHead> : null}
              {show("plan") ? <TableHead>Plan</TableHead> : null}
              {show("subscriber") ? <TableHead>Subscriber</TableHead> : null}
              <TableHead className="text-right">Amount</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Collected by</TableHead>
              <TableHead>Transaction</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payments.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="num whitespace-nowrap text-muted-foreground">{formatDateTime(p.paidAt ?? p.createdAt)}</TableCell>
                {show("merchant") ? <TableCell>{p.merchantName}</TableCell> : null}
                {show("plan") ? <TableCell>{p.planName}</TableCell> : null}
                {show("subscriber") ? <TableCell className="font-mono text-[0.8125rem]" title={p.subscriberAddress}>{shortAddress(p.subscriberAddress)}</TableCell> : null}
                <TableCell className="text-right"><Musd value={p.amount} /></TableCell>
                <TableCell>{statusOf(p)}</TableCell>
                <TableCell className="text-muted-foreground">{p.collectorKind ? COLLECTOR[p.collectorKind] : "--"}</TableCell>
                <TableCell>{txOf(p)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <ul className="divide-y md:hidden">
        {payments.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-3 py-3">
            <div className="min-w-0 space-y-0.5">
              <p className="truncate text-sm font-medium">
                {show("merchant") ? `${p.merchantName}, ` : ""}
                {p.planName}
              </p>
              {show("subscriber") ? <p className="font-mono text-xs text-muted-foreground">{shortAddress(p.subscriberAddress)}</p> : null}
              <p className="num text-xs text-muted-foreground">{formatDateTime(p.paidAt ?? p.createdAt)}</p>
              <div>{txOf(p)}</div>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-1">
              <Musd value={p.amount} className="text-sm font-medium" />
              {statusOf(p)}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
