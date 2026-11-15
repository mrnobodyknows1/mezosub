"use client";

import Link from "next/link";
import { ExternalLink, Plus } from "lucide-react";
import type { PlanDTO } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { intervalLabel, isDemoInterval, musd, perInterval, pluralize, trialLabel } from "@/lib/client/format";
import { PLAN_STATUS } from "@/lib/client/status";
import { build } from "@/lib/client/writes";
import { usePlans } from "@/hooks/use-api";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionDialog } from "@/components/shared/action-dialog";
import { CopyButton } from "@/components/shared/copy-button";
import { EmptyState } from "@/components/shared/empty-state";
import { Musd } from "@/components/shared/money";
import { PageHeader } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { DemoNote } from "./form-bits";
import { confirmPlanTx } from "./merchant-api";

function Price({ plan }: { plan: PlanDTO }) {
  return (
    <div className="min-w-0">
      <p className="num font-medium whitespace-nowrap">
        {musd(plan.price)} MUSD <span className="font-normal text-muted-foreground">{perInterval(plan.billingInterval)}</span>
      </p>
      <p className="text-xs text-muted-foreground">
        {isDemoInterval(plan.billingInterval) ? <DemoNote className="text-xs" /> : intervalLabel(plan.billingInterval)}
        {trialLabel(plan.trialSeconds) ? `, ${trialLabel(plan.trialSeconds)}` : ""}
      </p>
    </div>
  );
}

function StatusActions({ plan }: { plan: PlanDTO }) {
  if (!plan.onchainPlanId) {
    return (
      <Button asChild size="sm" variant="outline">
        <Link href={`/merchant/plans/${plan.id}`}>Publish</Link>
      </Button>
    );
  }
  if (!isDeployed || plan.status === "archived") return null;
  const id = BigInt(plan.onchainPlanId);
  const record = (hash: `0x${string}`) => confirmPlanTx(plan.id, hash);
  return (
    <>
      {plan.status === "active" ? (
        <ActionDialog
          trigger={<Button size="sm" variant="outline">Pause</Button>}
          title={`Pause ${plan.name}?`}
          body="New people can't subscribe while it's paused. Existing subscribers keep billing as usual."
          walletAsk="Your wallet will send one transaction to pause this plan. You pay a small network fee in BTC."
          confirmLabel="Pause plan"
          onConfirm={async (tx) => Boolean(await tx.run(build.pausePlan(id), { record, successMessage: "Plan paused" }))}
        />
      ) : (
        <ActionDialog
          trigger={<Button size="sm" variant="outline">Resume</Button>}
          title={`Resume ${plan.name}?`}
          body="The checkout link starts taking new subscribers again."
          walletAsk="Your wallet will send one transaction to resume this plan. You pay a small network fee in BTC."
          confirmLabel="Resume plan"
          onConfirm={async (tx) => Boolean(await tx.run(build.resumePlan(id), { record, successMessage: "Plan resumed" }))}
        />
      )}
      <ActionDialog
        trigger={<Button size="sm" variant="ghost">Archive</Button>}
        title={`Archive ${plan.name}?`}
        body="Archiving closes the plan to new subscribers for good. Existing subscribers keep billing until they or you cancel."
        walletAsk="Your wallet will send one transaction to archive this plan. This can't be undone. You pay a small network fee in BTC."
        confirmLabel="Archive plan"
        destructive
        onConfirm={async (tx) => Boolean(await tx.run(build.archivePlan(id), { record, successMessage: "Plan archived" }))}
      />
    </>
  );
}

function LinkActions({ plan }: { plan: PlanDTO }) {
  if (!plan.onchainPlanId || plan.status === "draft") return <span className="text-[0.8125rem] text-muted-foreground">Publish to get a link</span>;
  return (
    <div className="flex items-center gap-1">
      <CopyButton value={plan.checkoutUrl} text="Copy link" />
      <Button asChild variant="ghost" size="icon-sm" aria-label={`Open checkout for ${plan.name}`}>
        <a href={plan.checkoutUrl} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden />
        </a>
      </Button>
    </div>
  );
}

export function PlansList() {
  const q = usePlans();
  const newBtn = (
    <Button asChild size="sm">
      <Link href="/merchant/plans/new">
        <Plus aria-hidden /> New plan
      </Link>
    </Button>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Plans" description="Each plan has its own checkout link. Share it anywhere." actions={newBtn} />

      {q.isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : q.isError ? (
        <QueryError error={q.error} onRetry={() => void q.refetch()} />
      ) : !q.data?.length ? (
        <EmptyState
          title="No plans yet"
          body="Set a price and how often subscribers pay. You'll get a link to share."
          action={
            <Button asChild>
              <Link href="/merchant/plans/new">Create a plan</Link>
            </Button>
          }
        />
      ) : (
        <>
          <div className="hidden rounded-xl border bg-card md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Plan</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Subscribers</TableHead>
                  <TableHead className="text-right">MRR</TableHead>
                  <TableHead>Checkout link</TableHead>
                  <TableHead className="pr-4 text-right">
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="max-w-56 pl-4">
                      <Link href={`/merchant/plans/${p.id}`} className="font-medium underline-offset-4 hover:underline">
                        {p.name}
                      </Link>
                      {p.visibility === "unlisted" ? <p className="text-xs text-muted-foreground">Unlisted</p> : null}
                    </TableCell>
                    <TableCell>
                      <Price plan={p} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge meta={PLAN_STATUS[p.status]} />
                    </TableCell>
                    <TableCell className="num text-right">{p.activeSubscribers.toLocaleString()}</TableCell>
                    <TableCell className="text-right">
                      <Musd value={p.mrr} />
                    </TableCell>
                    <TableCell>
                      <LinkActions plan={p} />
                    </TableCell>
                    <TableCell className="pr-4">
                      <div className="flex justify-end gap-1">
                        <Button asChild size="sm" variant="ghost">
                          <Link href={`/merchant/plans/${p.id}`}>Edit</Link>
                        </Button>
                        <StatusActions plan={p} />
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <ul className="space-y-3 md:hidden">
            {q.data.map((p) => (
              <li key={p.id} className="rounded-xl border bg-card p-4">
                <div className="flex items-start justify-between gap-3">
                  <Link href={`/merchant/plans/${p.id}`} className="min-w-0 font-medium underline-offset-4 hover:underline">
                    {p.name}
                  </Link>
                  <StatusBadge meta={PLAN_STATUS[p.status]} />
                </div>
                <div className="mt-2">
                  <Price plan={p} />
                </div>
                <p className="num mt-2 text-[0.8125rem] text-muted-foreground">
                  {pluralize(p.activeSubscribers, "subscriber")}, <Musd value={p.mrr} /> a month
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <LinkActions plan={p} />
                  <Button asChild size="sm" variant="ghost">
                    <Link href={`/merchant/plans/${p.id}`}>Edit</Link>
                  </Button>
                  <StatusActions plan={p} />
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
