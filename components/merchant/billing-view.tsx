"use client";

import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { BillingJobDTO, BillingOverviewDTO, MerchantDTO, SubscriptionDTO } from "@/lib/api-types";
import { isDeployed, type CollectionCheck } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { COLLECTION_REASONS } from "@/lib/client/errors";
import { formatBillingDate, formatDateTime, musd, relativeTime, shortAddress } from "@/lib/client/format";
import { JOB_STATUS } from "@/lib/client/status";
import { build } from "@/lib/client/writes";
import { useBilling, useMerchant } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ActionDialog } from "@/components/shared/action-dialog";
import { AddressText, TxLink } from "@/components/shared/address";
import { Musd } from "@/components/shared/money";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { PageHeader, Panel } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { confirmMerchantTx, describeDelays, syncSubscriptionTx } from "./merchant-api";

function errorWords(e: string | null): string {
  if (!e) return "No reason recorded";
  const r = COLLECTION_REASONS[e as CollectionCheck];
  return r ? `${r.title}. ${r.fix}` : e;
}

function CollectButton({ sub, merchant }: { sub: SubscriptionDTO; merchant: MerchantDTO }) {
  if (!isDeployed) return null;
  const blocked = merchant.chainStatus !== "active";
  return (
    <ActionDialog
      trigger={
        <Button size="sm" disabled={blocked} title={blocked ? "Resume billing in Settings to collect." : undefined}>
          Collect due payment
        </Button>
      }
      title="Collect this payment?"
      body={
        <>
          <span className="num">{musd(sub.amountDue)} MUSD</span> from <span className="font-mono">{shortAddress(sub.subscriberAddress)}</span> for {sub.plan.name}.
        </>
      }
      walletAsk={
        <>
          Your wallet will send one transaction. The contract moves <span className="num text-foreground">{musd(sub.amountDue)} MUSD</span> from the subscriber to
          your payout wallet. You pay a small network fee in BTC.
        </>
      }
      confirmLabel="Collect payment"
      onConfirm={async (tx) =>
        Boolean(
          await tx.run(build.collectPayment(BigInt(sub.onchainSubscriptionId)), {
            record: (hash) => syncSubscriptionTx(sub.id, hash),
            successMessage: "Payment collected",
          }),
        )
      }
    />
  );
}

function RetryButton({ job }: { job: BillingJobDTO }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/api/subscriptions/${job.subscriptionId}/retry`, { method: "POST", json: {} });
          toast.success("Retry queued", { description: "The keeper will try this payment again in a moment." });
          void qc.invalidateQueries({ queryKey: ["api", "billing"] });
        } catch (e) {
          toast.error("Couldn't queue a retry", { description: errorMessage(e) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Queuing…" : "Retry now"}
    </Button>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <ul className="divide-y">{children}</ul>;
}

function DueSection({ data, merchant }: { data: BillingOverviewDTO; merchant: MerchantDTO }) {
  return (
    <Panel
      title="Due now"
      description={data.due.length ? `${data.due.length} payment${data.due.length === 1 ? "" : "s"} ready to collect.` : undefined}
      bodyClassName="py-1"
    >
      {!isDeployed ? (
        <div className="py-3">
          <NotDeployedNotice />
        </div>
      ) : !data.due.length ? (
        <p className="py-4 text-sm text-muted-foreground">Nothing is due right now.</p>
      ) : (
        <Rows>
          {data.due.map((s) => (
            <li key={s.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium">
                  <Link href={`/merchant/subscribers/${s.id}`} className="underline-offset-4 hover:underline">
                    {s.plan.name}
                  </Link>
                </p>
                <p className="text-[0.8125rem] text-muted-foreground">
                  <AddressText address={s.subscriberAddress} link={false} /> <span className="num">due since {formatBillingDate(s.nextBillingAt, s.billingInterval)}</span>
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <Musd value={s.amountDue} className="text-sm font-medium" />
                <CollectButton sub={s} merchant={merchant} />
              </div>
            </li>
          ))}
        </Rows>
      )}
    </Panel>
  );
}

function FailingSection({ jobs }: { jobs: BillingJobDTO[] }) {
  return (
    <Panel title="Failing" description={jobs.length ? "Payments that didn't go through. Subscribers are notified to fix funding." : undefined} bodyClassName="py-1">
      {!jobs.length ? (
        <p className="py-4 text-sm text-muted-foreground">No failing payments.</p>
      ) : (
        <Rows>
          {jobs.map((j) => (
            <li key={j.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <Link href={`/merchant/subscribers/${j.subscriptionId}`} className="text-sm font-medium underline-offset-4 hover:underline">
                    {j.planName}
                  </Link>
                  <StatusBadge meta={JOB_STATUS[j.status]} />
                </div>
                <p className="font-mono text-xs text-muted-foreground">{shortAddress(j.subscriberAddress)}</p>
                <p className="text-[0.8125rem]">{errorWords(j.lastError)}</p>
                <p className="num text-xs text-muted-foreground">
                  {j.retryCount} {j.retryCount === 1 ? "retry" : "retries"} so far
                  {j.status === "retrying" ? `, next attempt ${relativeTime(j.nextAttemptAt)}` : ", no more automatic retries"}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3 sm:justify-end">
                <Musd value={j.amount} className="text-sm font-medium" />
                <RetryButton job={j} />
              </div>
            </li>
          ))}
        </Rows>
      )}
    </Panel>
  );
}

function JobList({ title, jobs, empty, timeOf }: { title: string; jobs: BillingJobDTO[]; empty: string; timeOf: (j: BillingJobDTO) => string }) {
  return (
    <Panel title={title} bodyClassName="py-1">
      {!jobs.length ? (
        <p className="py-4 text-sm text-muted-foreground">{empty}</p>
      ) : (
        <Rows>
          {jobs.map((j) => (
            <li key={j.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-sm">{j.planName}</p>
                <p className="num text-xs text-muted-foreground">
                  <span className="font-mono">{shortAddress(j.subscriberAddress)}</span> {timeOf(j)}
                </p>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5">
                <Musd value={j.amount} className="text-sm" />
                {j.txHash ? <TxLink hash={j.txHash} /> : <StatusBadge meta={JOB_STATUS[j.status]} />}
              </div>
            </li>
          ))}
        </Rows>
      )}
    </Panel>
  );
}

function KeeperPanel({ data, merchant }: { data: BillingOverviewDTO; merchant: MerchantDTO }) {
  const enabled = merchant.keeperEnabled;
  const k = data.keeper;
  const delays = data.retryPolicy.delaysSeconds;
  return (
    <Panel title="Automatic collection">
      <div className="space-y-4 text-sm">
        <div className="flex items-start justify-between gap-4">
          <p className="max-w-[52ch] text-muted-foreground">
            When on, MezoSub&apos;s keeper collects payments when they&apos;re due. It can&apos;t change amounts or where money goes.
          </p>
          {isDeployed && merchant.onchainMerchantId ? (
            <ActionDialog
              trigger={<Switch checked={enabled} aria-label={enabled ? "Turn off automatic collection" : "Turn on automatic collection"} />}
              title={enabled ? "Turn off automatic collection?" : "Turn on automatic collection?"}
              body={
                enabled
                  ? "Due payments will wait until you collect them yourself from this page."
                  : "MezoSub's keeper will collect due payments for you. You can still collect manually."
              }
              walletAsk="Your wallet will send one transaction to change this setting. You pay a small network fee in BTC."
              confirmLabel={enabled ? "Turn off" : "Turn on"}
              onConfirm={async (tx) =>
                Boolean(
                  await tx.run(build.setKeeperEnabled(BigInt(merchant.onchainMerchantId!), !enabled), {
                    record: (hash) => confirmMerchantTx(hash),
                    successMessage: enabled ? "Automatic collection is off" : "Automatic collection is on",
                  }),
                )
              }
            />
          ) : (
            <span className="text-[0.8125rem] font-medium">{enabled ? "On" : "Off"}</span>
          )}
        </div>
        <dl className="grid gap-x-6 gap-y-3 border-t pt-4 sm:grid-cols-3">
          <div>
            <dt className="text-[0.8125rem] text-muted-foreground">Status</dt>
            <dd className={!enabled ? "text-muted-foreground" : k.healthy ? "text-ok" : "text-warn"}>{!enabled ? "Off for your account" : k.healthy ? "Running" : "Not running right now"}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted-foreground">Last run</dt>
            <dd className="num">{k.lastRunAt ? relativeTime(k.lastRunAt) : "--"}</dd>
          </div>
          <div>
            <dt className="text-[0.8125rem] text-muted-foreground">Keeper wallet</dt>
            <dd>{k.address ? <AddressText address={k.address} /> : "--"}</dd>
          </div>
        </dl>
        <div className="border-t pt-4">
          <p>
            If a payment fails, it&apos;s retried {describeDelays(delays)}. After that the subscription is marked past due.
          </p>
          {data.retryPolicy.demoMode ? (
            <p className="mt-2 font-medium text-warn">Demo mode: retries happen {describeDelays(delays)}.</p>
          ) : null}
          {!k.healthy && enabled ? <p className="mt-2 text-[0.8125rem] text-muted-foreground">You can still collect due payments yourself above.</p> : null}
        </div>
      </div>
    </Panel>
  );
}

export function BillingView() {
  const q = useBilling();
  const m = useMerchant();

  return (
    <div className="space-y-6">
      <PageHeader title="Billing" description="Collect due payments, follow up on failures and see what's coming. Updates every 10 seconds." />
      {q.isLoading || m.isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-48" />
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : q.data && m.data ? (
        <>
          {m.data.chainStatus !== "active" ? (
            <p role="status" className="rounded-lg border border-warn/40 bg-warn/5 px-4 py-3 text-sm">
              Billing is paused for your account, so payments can&apos;t be collected.{" "}
              <Link href="/merchant/settings" className="font-medium underline underline-offset-4">
                Resume in Settings
              </Link>
            </p>
          ) : null}
          <DueSection data={q.data} merchant={m.data} />
          <FailingSection jobs={q.data.failing} />
          <div className="grid gap-6 lg:grid-cols-2">
            <JobList title="Upcoming" jobs={q.data.upcoming} empty="Nothing scheduled in the next 7 days." timeOf={(j) => `due ${formatDateTime(j.scheduledAt)}`} />
            <JobList title="Recent" jobs={q.data.recent} empty="No collections yet." timeOf={(j) => formatDateTime(j.updatedAt)} />
          </div>
          <KeeperPanel data={q.data} merchant={m.data} />
        </>
      ) : null}
    </div>
  );
}
