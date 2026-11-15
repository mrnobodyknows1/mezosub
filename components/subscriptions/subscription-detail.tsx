"use client";

import type { ReactNode } from "react";
import type { Address } from "viem";
import type { BillingJobDTO, SubscriptionDetailDTO } from "@/lib/api-types";
import { formatBillingDate, formatDate, formatDateTime, intervalLabel, isDemoInterval, musd, perInterval, pluralize } from "@/lib/client/format";
import { JOB_STATUS, BILLING_STATUS } from "@/lib/client/status";
import { useSubscription } from "@/hooks/use-api";
import { useMusdAllowance } from "@/hooks/use-musd";
import { useWallet } from "@/hooks/use-wallet";
import { isDeployed } from "@/lib/chain/config";
import { Musd } from "@/components/shared/money";
import { AddressText, TxLink } from "@/components/shared/address";
import { Panel } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusBadge } from "@/components/shared/status-badge";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { PaymentsTable } from "@/components/payments/payments-table";
import { Skeleton } from "@/components/ui/skeleton";
import { SubscriptionStateBadge } from "./subscription-state-badge";
import { FailureBanner } from "./failure-banner";
import {
  CancelSubscriptionAction,
  CollectNowAction,
  RefundAction,
  RenewAuthorizationAction,
  RevokeAuthorizationAction,
} from "./subscription-actions";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[0.8125rem] text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium">{children}</dd>
    </div>
  );
}

function JobsList({ jobs }: { jobs: BillingJobDTO[] }) {
  if (!jobs.length) return <p className="text-sm text-muted-foreground">No collection attempts yet.</p>;
  return (
    <ul className="divide-y text-sm">
      {jobs.map((j) => (
        <li key={j.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2.5">
          <div className="min-w-0">
            <p>
              Payment {j.periodIndex + 1} <span className="num text-muted-foreground">({musd(j.amount)} MUSD)</span>
            </p>
            <p className="num text-xs text-muted-foreground">
              Scheduled {formatDateTime(j.scheduledAt)}
              {j.retryCount ? `, ${pluralize(j.retryCount, "retry", "retries")}` : ""}
              {j.lastError ? `, ${j.lastError}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {j.txHash ? <TxLink hash={j.txHash} /> : null}
            <StatusBadge meta={JOB_STATUS[j.status]} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-56 w-full rounded-xl" />
    </div>
  );
}

function Body({ sub, viewer }: { sub: SubscriptionDetailDTO; viewer: "merchant" | "subscriber" }) {
  const w = useWallet();
  const allowance = useMusdAllowance(viewer === "subscriber" ? (w.address as Address | undefined) : undefined);
  const active = sub.status === "active";
  const isSubscriberWallet = w.address?.toLowerCase() === sub.subscriberAddress.toLowerCase();

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          {sub.merchant.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={sub.merchant.logoUrl} alt="" className="size-11 shrink-0 rounded-lg border object-cover" />
          ) : (
            <div aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-muted text-base font-semibold">
              {sub.merchant.name.slice(0, 1).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">{sub.plan.name}</h1>
            <p className="text-sm text-muted-foreground">
              {viewer === "subscriber" ? sub.merchant.name : <AddressText address={sub.subscriberAddress} copy />}
            </p>
          </div>
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <SubscriptionStateBadge state={sub.state} />
          {sub.billingStatus !== "ok" && active ? <StatusBadge meta={BILLING_STATUS[sub.billingStatus]} /> : null}
        </div>
      </div>

      <FailureBanner
        sub={sub}
        viewer={viewer}
        allowance={allowance.data}
        committed={allowance.data !== undefined ? BigInt(sub.remainingCap) : undefined}
      />

      <Panel title="Terms" description={`Version ${sub.termsVersion}. These terms were fixed when the subscription started.`}>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <Fact label="Price">
            <span className="num">{musd(sub.amount)} MUSD</span> <span className="font-normal text-muted-foreground">{perInterval(sub.billingInterval)}</span>
          </Fact>
          <Fact label="Billing">
            {intervalLabel(sub.billingInterval)}
            {isDemoInterval(sub.billingInterval) ? <span className="block text-xs font-normal text-warn">Testnet demo interval</span> : null}
          </Fact>
          {sub.introPeriods > 0 && sub.introAmount !== "0" ? (
            <Fact label="Intro price">
              <span className="num">{musd(sub.introAmount)} MUSD</span>{" "}
              <span className="font-normal text-muted-foreground">for the first {pluralize(sub.introPeriods, "payment")}</span>
            </Fact>
          ) : null}
          <Fact label="Started">{formatDate(sub.createdAt)}</Fact>
          <Fact label="Next payment">
            {active ? (
              <>
                <span className="num">{musd(sub.amountDue)} MUSD</span>
                <span className="num block text-xs font-normal text-muted-foreground">{formatBillingDate(sub.nextBillingAt, sub.billingInterval)}</span>
              </>
            ) : (
              "None"
            )}
          </Fact>
          <Fact label="Last payment">{sub.lastPaymentAt ? formatBillingDate(sub.lastPaymentAt, sub.billingInterval) : "None yet"}</Fact>
          <Fact label="Paid in total">
            <Musd value={sub.totalPaid} />
            {sub.totalRefunded !== "0" ? (
              <span className="num block text-xs font-normal text-muted-foreground">{musd(sub.totalRefunded)} MUSD refunded</span>
            ) : null}
          </Fact>
          <Fact label="Payments">{sub.paymentsCount.toLocaleString()}</Fact>
        </dl>
      </Panel>

      <Panel title="Authorization" description="The most this subscription can still charge. Only the subscriber can change it.">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <Fact label="Limit left">
            <Musd value={sub.remainingCap} />
          </Fact>
          <Fact label="Covers">{active ? pluralize(sub.periodsCovered, "more payment") : "--"}</Fact>
          <Fact label="Ends">{sub.expiresAt ? formatDate(sub.expiresAt) : "No end date"}</Fact>
          <Fact label="Started with">
            <TxLink hash={sub.subscribeTxHash} label="Subscribe transaction" />
          </Fact>
        </dl>
        {sub.cancelledAt ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Cancelled {formatDateTime(sub.cancelledAt)}
            {sub.cancelledBy === "lapsed" ? ", because a payment stayed unpaid for a full billing period" : sub.cancelledBy ? ` by the ${sub.cancelledBy}` : ""}. Past payments aren&apos;t reversed automatically.
          </p>
        ) : null}
      </Panel>

      {!isDeployed ? (
        <NotDeployedNotice />
      ) : viewer === "subscriber" ? (
        active ? (
          isSubscriberWallet ? (
            <div className="flex flex-wrap items-center gap-2">
              <RenewAuthorizationAction sub={sub} variant="outline" />
              <CancelSubscriptionAction sub={sub} viewer="subscriber" />
              <RevokeAuthorizationAction sub={sub} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Connect the subscribing wallet to change this subscription.</p>
          )
        ) : null
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {sub.state === "due" || sub.state === "past_due" ? <CollectNowAction sub={sub} /> : null}
          <RefundAction sub={sub} />
          {active ? <CancelSubscriptionAction sub={sub} viewer="merchant" /> : null}
        </div>
      )}

      <Panel title="Payment history" bodyClassName="px-0 py-0 sm:px-0">
        {sub.payments.length ? (
          <div className="px-4 sm:px-5">
            <PaymentsTable payments={sub.payments} columns={[]} />
          </div>
        ) : (
          <div className="p-4 sm:p-5">
            <EmptyState title="No payments yet" body={sub.state === "trialing" ? "The first payment is taken when the trial ends." : undefined} />
          </div>
        )}
      </Panel>

      {viewer === "merchant" ? (
        <Panel title="Collection attempts">
          <JobsList jobs={sub.jobs} />
        </Panel>
      ) : null}
    </div>
  );
}

/** Full subscription view shared by the merchant dashboard and the subscriber account. */
export function SubscriptionDetail({ id, viewer }: { id: string; viewer: "merchant" | "subscriber" }) {
  const q = useSubscription(id);
  if (q.isLoading) return <DetailSkeleton />;
  if (q.error || !q.data) return <QueryError error={q.error ?? new Error("Subscription not found.")} onRetry={() => void q.refetch()} title="Couldn't load this subscription" />;
  return <Body sub={q.data} viewer={viewer} />;
}
