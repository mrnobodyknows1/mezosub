"use client";

import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { Address } from "viem";
import { ChevronRight } from "lucide-react";
import type { NotificationDTO, SubscriberDashboardDTO, SubscriptionDTO } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { formatBillingDate, formatDateTime, isDemoInterval, musd, perInterval, pluralize, relativeTime } from "@/lib/client/format";
import { qk, useMySubscriptions, useNotifications } from "@/hooks/use-api";
import { useMusdAllowance } from "@/hooks/use-musd";
import { useWallet } from "@/hooks/use-wallet";
import { PageHeader, Panel } from "@/components/shared/page-header";
import { Musd } from "@/components/shared/money";
import { EmptyState } from "@/components/shared/empty-state";
import { QueryError } from "@/components/shared/query-error";
import { PaymentsTable } from "@/components/payments/payments-table";
import { SubscriptionStateBadge } from "@/components/subscriptions/subscription-state-badge";
import { FailureBanner } from "@/components/subscriptions/failure-banner";
import {
  CancelSubscriptionAction,
  RemoveAllowanceAction,
  RenewAuthorizationAction,
  SetAllowanceAction,
} from "@/components/subscriptions/subscription-actions";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

function SubscriptionRow({ sub, allowance, committed }: { sub: SubscriptionDTO; allowance?: bigint; committed: bigint }) {
  const active = sub.status === "active";
  const needsRenew = sub.state === "expired" || sub.state === "cap_exhausted";
  return (
    <li className="space-y-3 py-5 first:pt-0 last:pb-0">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {sub.merchant.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sub.merchant.logoUrl} alt="" className="size-10 shrink-0 rounded-lg border object-cover" />
          ) : (
            <div aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted font-semibold">
              {sub.merchant.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <Link href={`/account/subscriptions/${sub.id}`} className="group inline-flex items-center gap-1 font-medium hover:underline underline-offset-4">
              {sub.plan.name}
              <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
            </Link>
            <p className="text-sm text-muted-foreground">
              {sub.merchant.name}, <span className="num">{musd(sub.amount)}</span> MUSD {perInterval(sub.billingInterval)}
              {isDemoInterval(sub.billingInterval) ? <span className="text-warn"> (testnet demo)</span> : null}
            </p>
          </div>
        </div>
        <SubscriptionStateBadge state={sub.state} />
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Next payment</dt>
          <dd className="num mt-0.5">{active ? formatBillingDate(sub.nextBillingAt, sub.billingInterval) : "None"}</dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Last payment</dt>
          <dd className="num mt-0.5">{sub.lastPaymentAt ? formatBillingDate(sub.lastPaymentAt, sub.billingInterval) : "None yet"}</dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Limit left</dt>
          <dd className="mt-0.5">
            <Musd value={sub.remainingCap} />
          </dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Covers</dt>
          <dd className="mt-0.5">{active ? pluralize(sub.periodsCovered, "more payment") : "--"}</dd>
        </div>
      </dl>

      <FailureBanner sub={sub} viewer="subscriber" allowance={allowance} committed={committed} />

      {active && isDeployed ? (
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href={`/account/subscriptions/${sub.id}`}>Details</Link>
          </Button>
          {!needsRenew ? <RenewAuthorizationAction sub={sub} variant="outline" /> : null}
          <CancelSubscriptionAction sub={sub} viewer="subscriber" />
        </div>
      ) : null}
    </li>
  );
}

function AllowanceSummary({ data, live }: { data: SubscriberDashboardDTO["allowance"]; live?: bigint }) {
  const current = live ?? BigInt(data.current);
  const committed = BigInt(data.committed);
  const short = committed > current ? committed - current : 0n;
  return (
    <Panel
      title="Allowance"
      description="Your MUSD allowance lets MezoSub's contract move MUSD for all your subscriptions. Each subscription still has its own limit."
    >
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4">
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Current allowance</dt>
          <dd className="mt-0.5 text-lg font-semibold">
            <Musd value={current} />
          </dd>
        </div>
        <div>
          <dt className="text-[0.8125rem] text-muted-foreground">Active limits combined</dt>
          <dd className="mt-0.5 text-lg font-semibold">
            <Musd value={committed} />
          </dd>
        </div>
      </dl>
      <p className="mt-4 text-sm text-muted-foreground">
        {short > 0n
          ? `Your allowance is ${musd(short)} MUSD short of your active limits. Some payments may fail until you increase it.`
          : committed > 0n
            ? "Your allowance covers all your active limits."
            : "You have no active limits."}
      </p>
      {isDeployed ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {short > 0n ? <SetAllowanceAction current={current} target={committed} /> : null}
          {current > 0n ? <RemoveAllowanceAction /> : null}
        </div>
      ) : null}
    </Panel>
  );
}

function Notifications({ items }: { items: NotificationDTO[] }) {
  const qc = useQueryClient();
  const unread = items.filter((n) => !n.read);
  return (
    <Panel
      title="Notifications"
      actions={
        unread.length ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await api("/api/notifications/read", { method: "POST", json: { ids: unread.map((n) => n.id) } });
                void qc.invalidateQueries({ queryKey: qk.notifications });
              } catch (e) {
                toast.error("Couldn't update", { description: errorMessage(e) });
              }
            }}
          >
            Mark all read
          </Button>
        ) : null
      }
    >
      {items.length ? (
        <ul className="divide-y">
          {items.slice(0, 20).map((n) => (
            <li key={n.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex items-start justify-between gap-3">
                <p className={n.read ? "text-sm" : "text-sm font-medium"}>
                  {!n.read ? <span className="sr-only">Unread: </span> : null}
                  {n.link ? (
                    <Link href={n.link} className="hover:underline underline-offset-4">
                      {n.title}
                    </Link>
                  ) : (
                    n.title
                  )}
                </p>
                <time className="num shrink-0 text-xs text-muted-foreground" dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>
                  {relativeTime(n.createdAt)}
                </time>
              </div>
              {n.body ? <p className="mt-0.5 text-sm text-muted-foreground">{n.body}</p> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Nothing new.</p>
      )}
    </Panel>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-64 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-2">
        <Skeleton className="h-44 rounded-xl" />
        <Skeleton className="h-44 rounded-xl" />
      </div>
    </div>
  );
}

export function AccountDashboard() {
  const w = useWallet();
  const q = useMySubscriptions();
  const notes = useNotifications();
  const allowance = useMusdAllowance(w.address as Address | undefined);

  if (q.isLoading) return <DashboardSkeleton />;
  if (q.error || !q.data) return <QueryError error={q.error} onRetry={() => void q.refetch()} title="Couldn't load your subscriptions" />;

  const d = q.data;
  const committed = BigInt(d.allowance.committed);
  const current = d.subscriptions.filter((s) => s.status === "active");
  const ended = d.subscriptions.filter((s) => s.status !== "active");

  return (
    <div className="space-y-8">
      <PageHeader title="My subscriptions" description="Everything this wallet has authorized through MezoSub." />

      <Panel title="Active" description={current.length ? pluralize(current.length, "subscription") : undefined}>
        {current.length ? (
          <ul className="divide-y">
            {current.map((s) => (
              <SubscriptionRow key={s.id} sub={s} allowance={allowance.data} committed={committed} />
            ))}
          </ul>
        ) : (
          <EmptyState title="No active subscriptions" body="When you subscribe through a merchant's link, it shows up here." />
        )}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <AllowanceSummary data={d.allowance} live={allowance.data} />
        {notes.data ? <Notifications items={notes.data} /> : notes.isLoading ? <Skeleton className="h-44 rounded-xl" /> : <Notifications items={[]} />}
      </div>

      <Panel title="Payment history" bodyClassName="py-2">
        {d.payments.length ? <PaymentsTable payments={d.payments} columns={["merchant", "plan"]} /> : <p className="py-2 text-sm text-muted-foreground">No payments yet.</p>}
      </Panel>

      {ended.length ? (
        <Panel title="Ended">
          <ul className="divide-y">
            {ended.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <Link href={`/account/subscriptions/${s.id}`} className="min-w-0 hover:underline underline-offset-4">
                  <span className="font-medium">{s.plan.name}</span> <span className="text-muted-foreground">from {s.merchant.name}</span>
                </Link>
                <div className="flex items-center gap-4">
                  <span className="text-sm text-muted-foreground">
                    Paid <span className="num">{musd(s.totalPaid)}</span> MUSD
                  </span>
                  <SubscriptionStateBadge state={s.state} />
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
