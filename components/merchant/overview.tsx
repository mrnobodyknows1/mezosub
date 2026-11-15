"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import type { MerchantOverviewDTO } from "@/lib/api-types";
import { useOverview, usePlans } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Musd } from "@/components/shared/money";
import { PageHeader, Panel } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { EmptyState } from "@/components/shared/empty-state";
import { PaymentsTable } from "@/components/payments/payments-table";
import { RevenueChart } from "./revenue-chart";

function SyncLine({ r }: { r: MerchantOverviewDTO["reconciliation"] }) {
  let text: string;
  let tone = "text-muted-foreground";
  if (r.lagBlocks === null) text = "Waiting for the first sync with the chain.";
  else if (r.lagBlocks <= 5) text = "Synced with the chain.";
  else {
    text = `${r.lagBlocks.toLocaleString()} blocks behind the chain. Numbers may be a little out of date.`;
    tone = "text-warn";
  }
  return (
    <p className={`text-[0.8125rem] ${tone}`}>
      {text}
      {r.lastIndexedBlock ? <span className="num text-muted-foreground"> Last block {Number(r.lastIndexedBlock).toLocaleString()}.</span> : null}
      {r.mismatches > 0 ? <span className="text-warn"> {r.mismatches} record{r.mismatches === 1 ? "" : "s"} corrected from chain data.</span> : null}
    </p>
  );
}

function SmallStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 bg-card px-4 py-3 sm:px-5 [&:last-child:nth-child(odd)]:col-span-2 lg:[&:last-child:nth-child(odd)]:col-span-1">
      <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="num mt-0.5 text-lg font-semibold">{children}</dd>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid gap-6 sm:grid-cols-2">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <Skeleton className="h-20" />
      <Skeleton className="h-64" />
      <Skeleton className="h-48" />
    </div>
  );
}

export function MerchantOverview() {
  const q = useOverview();
  const plans = usePlans();
  const noPlans = plans.isSuccess && plans.data.length === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description={q.data ? <SyncLine r={q.data.reconciliation} /> : "Revenue and subscribers at a glance."}
        actions={
          <Button asChild size="sm">
            <Link href="/merchant/plans/new">
              <Plus aria-hidden /> New plan
            </Link>
          </Button>
        }
      />

      {noPlans ? (
        <EmptyState
          title="Create your first plan"
          body="A plan sets the price and how often subscribers pay. You'll get a checkout link to share."
          action={
            <Button asChild>
              <Link href="/merchant/plans/new">Create a plan</Link>
            </Button>
          }
        />
      ) : null}

      {q.isLoading ? (
        <OverviewSkeleton />
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data ? (
        <>
          <div className="grid gap-x-10 gap-y-6 sm:grid-cols-2">
            <div>
              <p className="text-sm text-muted-foreground">Revenue, all time</p>
              <p className="mt-1 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                <Musd value={q.data.totalRevenue} />
              </p>
            </div>
            <div>
              <p className="text-sm text-muted-foreground">Monthly recurring revenue</p>
              <p className="mt-1 text-3xl font-semibold tracking-[-0.02em] sm:text-4xl">
                <Musd value={q.data.mrr} />
              </p>
            </div>
          </div>

          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-5">
            <SmallStat label="Active subscribers">{q.data.activeSubscribers.toLocaleString()}</SmallStat>
            <SmallStat label="New, 30 days">{q.data.newSubscribers30d.toLocaleString()}</SmallStat>
            <SmallStat label="Cancelled, 30 days">{q.data.cancelled30d.toLocaleString()}</SmallStat>
            <SmallStat label="Failed payments, 30 days">
              <span className={q.data.failedPayments30d > 0 ? "text-bad" : undefined}>{q.data.failedPayments30d.toLocaleString()}</span>
            </SmallStat>
            <SmallStat label="Due in the next 7 days">
              <span className="block">{q.data.upcomingCollections7d.count.toLocaleString()}</span>
              <span className="block text-[0.8125rem] font-normal text-muted-foreground">
                <Musd value={q.data.upcomingCollections7d.amount} />
              </span>
            </SmallStat>
          </dl>

          <Panel title="Revenue" description="Collected per day, last 30 days (UTC).">
            <RevenueChart series={q.data.revenueSeries} />
          </Panel>

          <Panel
            title="Recent payments"
            actions={
              <Button asChild variant="ghost" size="sm">
                <Link href="/merchant/payments">View all</Link>
              </Button>
            }
            bodyClassName="px-0 py-0 sm:px-0 [&>*]:px-4 sm:[&>*]:px-2"
          >
            {q.data.recentPayments.length ? (
              <PaymentsTable payments={q.data.recentPayments} columns={["subscriber", "plan"]} />
            ) : (
              <p className="py-6 text-sm text-muted-foreground">No payments yet. They appear here once a subscriber pays.</p>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
