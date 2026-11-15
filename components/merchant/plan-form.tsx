"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Controller, useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, Info } from "lucide-react";
import type { PlanChainParams, PlanDTO } from "@/lib/api-types";
import { BILLING_INTERVALS, isDeployed } from "@/lib/chain/config";
import { tryParseMusd } from "@/lib/money";
import { api, errorMessage } from "@/lib/client/api";
import { intervalNoun, musd, perInterval, pluralize, trialLabel } from "@/lib/client/format";
import { PLAN_STATUS } from "@/lib/client/status";
import { build } from "@/lib/client/writes";
import { qk, usePlan } from "@/hooks/use-api";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TxPanel } from "@/components/shared/tx-panel";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { PageHeader, Panel } from "@/components/shared/page-header";
import { QueryError } from "@/components/shared/query-error";
import { StatusBadge } from "@/components/shared/status-badge";
import { CopyButton } from "@/components/shared/copy-button";
import { DemoNote, Field, inputErrorProps } from "./form-bits";
import { confirmPlanTx } from "./merchant-api";
import {
  EMPTY_PLAN,
  INTERVAL_KEYS,
  hasIntro,
  metaFromPlan,
  metaSchema,
  planSchema,
  termsChanged,
  termsFromPlan,
  termsSchema,
  toChainParams,
  toCreateRequest,
  toMetaRequest,
  trialSecondsOf,
  type MetaValues,
  type PlanValues,
  type TermsValues,
} from "./plan-schema";

// ------------------------------------------------------------------ fields

function MetaFields({ form }: { form: UseFormReturn<MetaValues> }) {
  const e = form.formState.errors;
  return (
    <div className="grid gap-5">
      <Field id="p-name" label="Plan name" error={e.name?.message} hint="Subscribers see this at checkout.">
        <Input id="p-name" autoComplete="off" placeholder="Pro monthly" {...inputErrorProps("p-name", e.name?.message)} {...form.register("name")} />
      </Field>
      <Field id="p-desc" label="Description" optional error={e.description?.message}>
        <Textarea id="p-desc" rows={3} {...inputErrorProps("p-desc", e.description?.message)} {...form.register("description")} />
      </Field>
      <Field id="p-features" label="What's included" optional error={e.features?.message} hint="One per line, up to 8.">
        <Textarea id="p-features" rows={4} {...inputErrorProps("p-features", e.features?.message)} {...form.register("features")} />
      </Field>
      <Field id="p-vis" label="Visibility" hint="Unlisted plans only open from their link.">
        <Controller
          control={form.control}
          name="visibility"
          render={({ field }) => (
            <Select value={field.value} onValueChange={field.onChange}>
              <SelectTrigger id="p-vis" className="w-full sm:w-60">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="public">Public</SelectItem>
                <SelectItem value="unlisted">Unlisted</SelectItem>
              </SelectContent>
            </Select>
          )}
        />
      </Field>
    </div>
  );
}

function TermsFields({ form }: { form: UseFormReturn<TermsValues> }) {
  const e = form.formState.errors;
  const interval = useWatch({ control: form.control, name: "interval" });
  const demo = interval === "demo_5m";
  return (
    <div className="grid gap-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="p-price" label="Price (MUSD)" error={e.price?.message} hint="Charged every billing period.">
          <Input id="p-price" inputMode="decimal" autoComplete="off" placeholder="9.99" className="num" {...inputErrorProps("p-price", e.price?.message)} {...form.register("price")} />
        </Field>
        <Field id="p-interval" label="Billing interval" hint={demo ? "For trying MezoSub on testnet. Renews every 5 minutes." : "Months are fixed 30-day periods."}>
          <Controller
            control={form.control}
            name="interval"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="p-interval" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INTERVAL_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>
                      {BILLING_INTERVALS[k].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
        </Field>
      </div>
      {demo ? (
        <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/5 px-3 py-2 text-[0.8125rem]">
          <Info className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span>
            <DemoNote />. Subscribers are charged every 5 minutes so you can watch renewals happen. Use a real interval for anything else.
          </span>
        </p>
      ) : null}
      <Field id="p-trial" label={demo ? "Free trial (minutes)" : "Free trial (days)"} optional error={e.trial?.message} hint="No charge until the trial ends.">
        <Input id="p-trial" inputMode="numeric" autoComplete="off" placeholder="0" className="num sm:w-40" {...inputErrorProps("p-trial", e.trial?.message)} {...form.register("trial")} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="p-intro" label="Intro price (MUSD)" optional error={e.introPrice?.message} hint="A lower price for the first few payments.">
          <Input id="p-intro" inputMode="decimal" autoComplete="off" className="num" {...inputErrorProps("p-intro", e.introPrice?.message)} {...form.register("introPrice")} />
        </Field>
        <Field id="p-intro-n" label="Intro payments" optional error={e.introPeriods?.message} hint="How many payments use the intro price (1 to 24).">
          <Input id="p-intro-n" inputMode="numeric" autoComplete="off" className="num" {...inputErrorProps("p-intro-n", e.introPeriods?.message)} {...form.register("introPeriods")} />
        </Field>
      </div>
      <Field id="p-max" label="Subscriber limit" optional error={e.maxSubscribers?.message} hint="Leave empty for no limit.">
        <Input id="p-max" inputMode="numeric" autoComplete="off" className="num sm:w-40" {...inputErrorProps("p-max", e.maxSubscribers?.message)} {...form.register("maxSubscribers")} />
      </Field>
    </div>
  );
}

// ------------------------------------------------------------------ summary

function Summary({ v, name }: { v: TermsValues; name?: string }) {
  const price = tryParseMusd(v.price);
  const seconds = BILLING_INTERVALS[v.interval].seconds;
  const trial = trialSecondsOf(v);
  const intro = hasIntro(v) ? tryParseMusd(v.introPrice) : null;
  const introN = intro ? Number(v.introPeriods) : 0;
  const first = intro ?? price;
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-muted-foreground">{name?.trim() || "Your plan"}</p>
        <p className="num mt-1 text-2xl font-semibold tracking-[-0.02em]">
          {price && price > 0n ? musd(price) : "0.00"} <span className="text-base font-normal text-muted-foreground">MUSD {perInterval(seconds)}</span>
        </p>
        {v.interval === "demo_5m" ? <DemoNote /> : null}
      </div>
      <dl className="space-y-2 border-t pt-4">
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">First payment</dt>
          <dd className="num text-right">
            {first && first > 0n ? `${musd(first)} MUSD` : "--"}
            <span className="block text-xs text-muted-foreground">{trial ? `after the ${trialLabel(trial)}` : "when they subscribe"}</span>
          </dd>
        </div>
        {intro && introN ? (
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Intro price</dt>
            <dd className="num text-right">
              {musd(intro)} MUSD for {pluralize(introN, "payment")}
            </dd>
          </div>
        ) : null}
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Then</dt>
          <dd className="num text-right">
            {price && price > 0n ? `${musd(price)} MUSD` : "--"} every {intervalNoun(seconds)}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-muted-foreground">Platform fee</dt>
          <dd className="num">0%</dd>
        </div>
      </dl>
      <p className="border-t pt-4 text-[0.8125rem] text-muted-foreground">
        Subscribers approve a spending limit and can cancel anytime. Payments are collected when due, by you or MezoSub&apos;s keeper.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ publish

function usePublish() {
  const tx = useTx();
  const qc = useQueryClient();
  async function publish(plan: PlanDTO) {
    let params: PlanChainParams;
    try {
      params = await api<PlanChainParams>(`/api/plans/${plan.id}/chain-params`);
    } catch (e) {
      toast.error("Couldn't load the plan terms", { description: errorMessage(e) });
      return null;
    }
    const res = await tx.run(build.createPlan(params), {
      record: (hash) => confirmPlanTx(plan.id, hash),
      successMessage: "Plan published",
    });
    if (res) await qc.invalidateQueries({ queryKey: ["api"] });
    return res;
  }
  return { tx, publish };
}

const PUBLISH_ASK = "Your wallet will send one transaction to publish this plan on Mezo Testnet. You pay a small network fee in BTC. Nothing is charged to anyone yet.";

// ------------------------------------------------------------------ create

export function CreatePlan() {
  const router = useRouter();
  const qc = useQueryClient();
  const w = useWallet();
  const [draft, setDraft] = useState<PlanDTO | null>(null);
  const { tx, publish } = usePublish();
  const form = useForm<PlanValues>({ resolver: zodResolver(planSchema), defaultValues: EMPTY_PLAN });
  const values = useWatch({ control: form.control }) as PlanValues;

  async function onSubmit(v: PlanValues) {
    let plan = draft;
    if (!plan) {
      try {
        plan = await api<PlanDTO>("/api/plans", { method: "POST", json: toCreateRequest(v) });
        setDraft(plan);
        qc.setQueryData(qk.plan(plan.id), plan);
        void qc.invalidateQueries({ queryKey: qk.plans });
      } catch (e) {
        toast.error("Couldn't save the plan", { description: errorMessage(e) });
        return;
      }
    }
    if (!isDeployed) {
      toast.success("Draft saved", { description: "Publish it once the contracts are deployed." });
      router.push(`/merchant/plans/${plan.id}`);
      return;
    }
    const res = await publish(plan);
    if (res?.recorded) {
      toast.success("Your checkout link is ready", { description: plan.checkoutUrl });
      router.push(`/merchant/plans/${plan.id}`);
    }
  }

  const submitting = form.formState.isSubmitting || tx.isBusy;
  return (
    <div className="space-y-6">
      <BackLink />
      <PageHeader title="New plan" description="Set the price and billing interval. Publishing it on-chain gives you a checkout link." />
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          <Panel title="Details">
            <MetaFields form={form as unknown as UseFormReturn<MetaValues>} />
          </Panel>
          <Panel title="Pricing" description={draft ? "Saved as a draft. To change pricing now, start a new plan." : undefined}>
            <fieldset disabled={Boolean(draft)} className="disabled:opacity-60">
              <TermsFields form={form as unknown as UseFormReturn<TermsValues>} />
            </fieldset>
          </Panel>
          <div className="space-y-3">
            {isDeployed ? <TxPanel state={tx.state} description={PUBLISH_ASK} onRetryRecord={tx.retryRecord} /> : <NotDeployedNotice />}
            <div className="flex flex-wrap gap-2">
              {tx.state.phase === "success" && tx.state.recordError && draft ? (
                <Button type="button" onClick={() => router.push(`/merchant/plans/${draft.id}`)}>
                  Continue
                </Button>
              ) : (
                <Button type="submit" disabled={submitting || (isDeployed && !w.isReady)}>
                  {submitting ? "Working…" : !isDeployed ? "Save draft" : !w.isReady ? "Switch to Mezo Testnet first" : draft ? "Publish plan" : "Save and publish"}
                </Button>
              )}
              <Button type="button" variant="ghost" asChild>
                <Link href="/merchant/plans">Cancel</Link>
              </Button>
            </div>
          </div>
        </div>
        <aside className="lg:sticky lg:top-6 lg:self-start">
          <Panel title="What subscribers see">
            <Summary v={values} name={values.name} />
          </Panel>
        </aside>
      </form>
    </div>
  );
}

// ------------------------------------------------------------------ edit

function BackLink() {
  return (
    <Link href="/merchant/plans" className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
      <ArrowLeft className="size-4" aria-hidden /> Plans
    </Link>
  );
}

function MetaForm({ plan }: { plan: PlanDTO }) {
  const qc = useQueryClient();
  const form = useForm<MetaValues>({ resolver: zodResolver(metaSchema), defaultValues: metaFromPlan(plan) });
  async function onSubmit(v: MetaValues) {
    try {
      const updated = await api<PlanDTO>(`/api/plans/${plan.id}`, { method: "PATCH", json: toMetaRequest(v) });
      if (updated && typeof updated === "object" && "id" in updated) qc.setQueryData(qk.plan(plan.id), updated);
      void qc.invalidateQueries({ queryKey: qk.plans });
      form.reset(v);
      toast.success("Details saved");
    } catch (e) {
      toast.error("Couldn't save", { description: errorMessage(e) });
    }
  }
  return (
    <Panel title="Details" description="Name, description and visibility. Saving these doesn't need a transaction.">
      <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
        <MetaFields form={form} />
        <div>
          <Button type="submit" variant="outline" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
            {form.formState.isSubmitting ? "Saving…" : "Save details"}
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function TermsForm({ plan }: { plan: PlanDTO }) {
  const w = useWallet();
  const qc = useQueryClient();
  const tx = useTx();
  const form = useForm<TermsValues>({ resolver: zodResolver(termsSchema), defaultValues: termsFromPlan(plan) });
  const values = useWatch({ control: form.control }) as TermsValues;
  const changed = termsChanged(values, plan);
  const archived = plan.status === "archived";

  async function onSubmit(v: TermsValues) {
    if (!plan.onchainPlanId) return;
    const params = toChainParams(v, plan.tokenAddress);
    const res = await tx.run(build.updatePlan(BigInt(plan.onchainPlanId), params), {
      record: (hash) => confirmPlanTx(plan.id, hash),
      successMessage: "New terms are live for new subscribers",
    });
    if (res) {
      await qc.invalidateQueries({ queryKey: ["api"] });
      form.reset(v);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel title="Pricing" description={`Terms version ${plan.termsVersion}.`}>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
          <p className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2.5 text-[0.8125rem] ring-1 ring-border">
            <Info className="mt-0.5 size-4 shrink-0 text-brand-ink" aria-hidden />
            <span>Existing subscribers keep the terms they signed up with. New terms apply to new subscribers only.</span>
          </p>
          <fieldset disabled={archived || tx.isBusy} className="disabled:opacity-60">
            <TermsFields form={form} />
          </fieldset>
          {archived ? (
            <p className="text-sm text-muted-foreground">Archived plans can&apos;t change terms.</p>
          ) : isDeployed ? (
            <>
              <TxPanel
                state={tx.state}
                onRetryRecord={tx.retryRecord}
                description="Your wallet will send one transaction to update the plan's terms. Current subscribers aren't affected. You pay a small network fee in BTC."
              />
              <div>
                <Button type="submit" disabled={!changed || tx.isBusy || !w.isReady}>
                  {tx.isBusy ? "Working…" : !w.isReady ? "Switch to Mezo Testnet first" : "Update terms"}
                </Button>
              </div>
            </>
          ) : (
            <NotDeployedNotice />
          )}
        </form>
      </Panel>
      <aside className="lg:sticky lg:top-6 lg:self-start">
        <Panel title="New subscribers see">
          <Summary v={values} name={plan.name} />
        </Panel>
      </aside>
    </div>
  );
}

function PublishDraft({ plan }: { plan: PlanDTO }) {
  const w = useWallet();
  const { tx, publish } = usePublish();
  const t = termsFromPlan(plan);
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <Panel title="Publish on-chain" description="This plan is a draft. Publish it to get a working checkout link.">
        {isDeployed ? (
          <div className="space-y-3">
            <TxPanel state={tx.state} description={PUBLISH_ASK} onRetryRecord={tx.retryRecord} />
            <Button onClick={() => void publish(plan)} disabled={tx.isBusy || !w.isReady || (tx.state.phase === "success" && !tx.state.recordError)}>
              {tx.isBusy ? "Working…" : !w.isReady ? "Switch to Mezo Testnet first" : "Publish plan"}
            </Button>
            <p className="text-[0.8125rem] text-muted-foreground">Draft pricing can&apos;t be edited. To change it, create a new plan.</p>
          </div>
        ) : (
          <NotDeployedNotice />
        )}
      </Panel>
      <aside>
        <Panel title="What subscribers see">
          <Summary v={t} name={plan.name} />
        </Panel>
      </aside>
    </div>
  );
}

export function EditPlan({ id }: { id: string }) {
  const q = usePlan(id);
  if (q.isLoading) {
    return (
      <div className="space-y-6">
        <BackLink />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    return (
      <div className="space-y-6">
        <BackLink />
        <QueryError error={q.error ?? new Error("Plan not found")} onRetry={() => void q.refetch()} title="Couldn't load this plan" />
      </div>
    );
  }
  const plan = q.data;
  const published = Boolean(plan.onchainPlanId) && plan.status !== "draft";
  return (
    <div className="space-y-6">
      <BackLink />
      <PageHeader
        title={plan.name}
        description={
          <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge meta={PLAN_STATUS[plan.status]} />
            <span className="num">
              {pluralize(plan.activeSubscribers, "active subscriber")}
              {plan.maxSubscribers ? ` of ${plan.maxSubscribers.toLocaleString()}` : ""}
            </span>
          </span>
        }
        actions={
          published ? (
            <>
              <CopyButton value={plan.checkoutUrl} text="Copy checkout link" />
              <Button asChild variant="ghost" size="sm">
                <a href={plan.checkoutUrl} target="_blank" rel="noreferrer">
                  Open checkout <ExternalLink aria-hidden />
                </a>
              </Button>
            </>
          ) : null
        }
      />
      {published ? (
        <p className="truncate rounded-lg border bg-surface px-3 py-2 font-mono text-[0.8125rem]" title={plan.checkoutUrl}>
          {plan.checkoutUrl}
        </p>
      ) : null}
      {published ? <TermsForm plan={plan} /> : <PublishDraft plan={plan} />}
      <MetaForm plan={plan} />
    </div>
  );
}
