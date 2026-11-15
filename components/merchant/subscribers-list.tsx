"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { formatBillingDate, formatDate, shortAddress } from "@/lib/client/format";
import { subscriptionStateMeta } from "@/lib/client/status";
import { useSubscriptions } from "@/hooks/use-api";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { EmptyState } from "@/components/shared/empty-state";
import { Musd } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { FilterBar, Pagination } from "./form-bits";

const FILTERS = [
  { value: "", label: "All" },
  { value: "active", label: "Active" },
  { value: "trialing", label: "Trial" },
  { value: "due", label: "Due" },
  { value: "past_due", label: "Past due" },
  { value: "cap_exhausted", label: "Limit reached" },
  { value: "expired", label: "Expired" },
  { value: "cancelled", label: "Cancelled" },
];

export function SubscribersList() {
  const router = useRouter();
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const q = useSubscriptions("merchant", status, page);
  const items = q.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Subscribers" description="Everyone subscribed to your plans, with their billing state." />
      <FilterBar
        label="Filter by state"
        value={status}
        options={FILTERS}
        onChange={(v) => {
          setStatus(v);
          setPage(1);
        }}
      />

      {q.isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-12" />
          ))}
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : !items.length ? (
        <EmptyState
          title={status ? "No subscribers in this state" : "No subscribers yet"}
          body={status ? "Try another filter." : "Share a plan's checkout link to get your first subscriber."}
          action={
            status ? undefined : (
              <Link href="/merchant/plans" className="text-sm font-medium underline underline-offset-4">
                Go to plans
              </Link>
            )
          }
        />
      ) : (
        <div className={q.isPlaceholderData ? "opacity-60 transition-opacity" : undefined}>
          <div className="hidden rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Wallet</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Next billing</TableHead>
                  <TableHead>Last payment</TableHead>
                  <TableHead className="pr-4 text-right">Paid total</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((s) => {
                  const href = `/merchant/subscribers/${s.id}`;
                  return (
                    <TableRow key={s.id} className="cursor-pointer hover:bg-muted/50" onClick={() => router.push(href)}>
                      <TableCell className="pl-4">
                        <Link href={href} className="font-mono text-[0.8125rem] underline-offset-4 hover:underline" title={s.subscriberAddress} onClick={(e) => e.stopPropagation()}>
                          {shortAddress(s.subscriberAddress)}
                        </Link>
                      </TableCell>
                      <TableCell>{s.plan.name}</TableCell>
                      <TableCell>
                        <StatusBadge meta={subscriptionStateMeta(s.state)} />
                      </TableCell>
                      <TableCell className="num text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                      <TableCell className="num">{s.status === "cancelled" ? <span className="text-muted-foreground">--</span> : formatBillingDate(s.nextBillingAt, s.billingInterval)}</TableCell>
                      <TableCell className="num text-muted-foreground">{s.lastPaymentAt ? formatBillingDate(s.lastPaymentAt, s.billingInterval) : "--"}</TableCell>
                      <TableCell className="pr-4 text-right">
                        <Musd value={s.totalPaid} />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          <ul className="divide-y rounded-xl border bg-card md:hidden">
            {items.map((s) => (
              <li key={s.id}>
                <Link href={`/merchant/subscribers/${s.id}`} className="flex items-center gap-3 px-4 py-3 focus-visible:bg-muted focus-visible:outline-none">
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[0.8125rem]">{shortAddress(s.subscriberAddress)}</span>
                      <StatusBadge meta={subscriptionStateMeta(s.state)} />
                    </div>
                    <p className="truncate text-sm">{s.plan.name}</p>
                    <p className="num text-xs text-muted-foreground">
                      {s.status === "cancelled" ? `Started ${formatDate(s.createdAt)}` : `Next ${formatBillingDate(s.nextBillingAt, s.billingInterval)}`}, paid <Musd value={s.totalPaid} />
                    </p>
                  </div>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
          {q.data ? <Pagination page={q.data.page} pageSize={q.data.pageSize} total={q.data.total} onPage={setPage} /> : null}
        </div>
      )}
    </div>
  );
}
