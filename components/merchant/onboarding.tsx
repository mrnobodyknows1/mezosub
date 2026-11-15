"use client";

import { useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { isAddress, type Address } from "viem";
import { toast } from "sonner";
import { Check } from "lucide-react";
import type { CreateMerchantRequest, MerchantDTO } from "@/lib/api-types";
import { isDeployed } from "@/lib/chain/config";
import { api, errorMessage } from "@/lib/client/api";
import { shortAddress } from "@/lib/client/format";
import { build } from "@/lib/client/writes";
import { cn } from "@/lib/client/utils";
import { qk } from "@/hooks/use-api";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { TxPanel } from "@/components/shared/tx-panel";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { Field, inputErrorProps } from "./form-bits";
import { confirmMerchantTx } from "./merchant-api";

const optionalUrl = z
  .string()
  .trim()
  .refine((v) => v === "" || /^https?:\/\/[^\s]+\.[^\s]+/i.test(v), "Enter a full URL starting with https://");

export const profileSchema = z.object({
  name: z.string().trim().min(2, "Use at least 2 characters").max(80, "Keep it under 80 characters"),
  description: z.string().trim().max(500, "Keep it under 500 characters"),
  logoUrl: z
    .string()
    .trim()
    .refine((v) => v === "" || /^https:\/\/[^\s]+\.[^\s]+/i.test(v), "Logo URL must start with https://"),
  website: optionalUrl,
  supportEmail: z
    .string()
    .trim()
    .refine((v) => v === "" || z.email().safeParse(v).success, "Enter a valid email"),
});
export type ProfileValues = z.infer<typeof profileSchema>;

export function toMerchantRequest(v: ProfileValues): CreateMerchantRequest {
  return {
    name: v.name,
    description: v.description,
    logoUrl: v.logoUrl || null,
    website: v.website || null,
    supportEmail: v.supportEmail || null,
  };
}

export function profileDefaults(m: MerchantDTO | null): ProfileValues {
  return {
    name: m?.name ?? "",
    description: m?.description ?? "",
    logoUrl: m?.logoUrl ?? "",
    website: m?.website ?? "",
    supportEmail: m?.supportEmail ?? "",
  };
}

/** Shared profile fields (used by onboarding and settings). */
export function ProfileForm({
  merchant,
  submitLabel,
  onSaved,
  method,
}: {
  merchant: MerchantDTO | null;
  submitLabel: string;
  onSaved?: (m: MerchantDTO) => void;
  method: "POST" | "PATCH";
}) {
  const qc = useQueryClient();
  const form = useForm<ProfileValues>({ resolver: zodResolver(profileSchema), defaultValues: profileDefaults(merchant) });
  const { errors, isSubmitting } = form.formState;

  async function onSubmit(v: ProfileValues) {
    try {
      const m = await api<MerchantDTO>(method === "POST" ? "/api/merchants" : "/api/merchants/me", { method, json: toMerchantRequest(v) });
      qc.setQueryData(qk.merchant, m);
      void qc.invalidateQueries({ queryKey: ["api", "session"] });
      toast.success(method === "POST" ? "Profile saved" : "Profile updated");
      onSaved?.(m);
    } catch (e) {
      toast.error("Couldn't save the profile", { description: errorMessage(e) });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} noValidate className="grid gap-5">
      <Field id="m-name" label="Business name" error={errors.name?.message} hint="Shown to subscribers at checkout.">
        <Input id="m-name" autoComplete="organization" {...inputErrorProps("m-name", errors.name?.message)} {...form.register("name")} />
      </Field>
      <Field id="m-desc" label="Description" optional error={errors.description?.message} hint="One or two sentences about what you offer.">
        <Textarea id="m-desc" rows={3} {...inputErrorProps("m-desc", errors.description?.message)} {...form.register("description")} />
      </Field>
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="m-logo" label="Logo URL" optional error={errors.logoUrl?.message} hint="A square image works best.">
          <Input id="m-logo" type="url" inputMode="url" placeholder="https://" {...inputErrorProps("m-logo", errors.logoUrl?.message)} {...form.register("logoUrl")} />
        </Field>
        <Field id="m-web" label="Website" optional error={errors.website?.message}>
          <Input id="m-web" type="url" inputMode="url" autoComplete="url" placeholder="https://" {...inputErrorProps("m-web", errors.website?.message)} {...form.register("website")} />
        </Field>
      </div>
      <Field id="m-email" label="Support email" optional error={errors.supportEmail?.message} hint="Where subscribers can reach you.">
        <Input id="m-email" type="email" autoComplete="email" {...inputErrorProps("m-email", errors.supportEmail?.message)} {...form.register("supportEmail")} />
      </Field>
      <div>
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

const STEPS = ["Profile", "Register on-chain", "First plan"] as const;

function StepIndicator({ step }: { step: 0 | 1 | 2 }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm" aria-label="Setup progress">
      {STEPS.map((s, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <li key={s} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
            <span
              className={cn(
                "num flex size-6 items-center justify-center rounded-full text-xs font-medium",
                done ? "bg-brand text-brand-foreground" : current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {done ? <Check className="size-3.5" aria-label="Done" /> : i + 1}
            </span>
            <span className={current ? "font-medium" : "text-muted-foreground"}>{s}</span>
          </li>
        );
      })}
    </ol>
  );
}

function RegisterStep({ merchant, onEdit, onDone }: { merchant: MerchantDTO; onEdit: () => void; onDone: () => void }) {
  const w = useWallet();
  const qc = useQueryClient();
  const tx = useTx();
  const [payout, setPayout] = useState<string>(w.address ?? "");
  const valid = isAddress(payout);
  const error = payout && !valid ? "Enter a valid wallet address (0x…)." : undefined;

  async function register() {
    if (!valid) return;
    const res = await tx.run(build.registerMerchant(payout as Address, merchant.metadataURI), {
      record: (hash) => confirmMerchantTx(hash),
      successMessage: "You're registered as a merchant",
    });
    if (res) {
      await qc.invalidateQueries({ queryKey: ["api"] });
      if (res.recorded) onDone();
    }
  }

  return (
    <div className="grid gap-6">
      <div className="rounded-lg border px-4 py-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{merchant.name}</p>
            {merchant.description ? <p className="mt-0.5 text-muted-foreground">{merchant.description}</p> : null}
          </div>
          <Button variant="ghost" size="sm" onClick={onEdit}>
            Edit
          </Button>
        </div>
      </div>

      <Field
        id="payout"
        label="Payout wallet"
        error={error}
        hint="Collected MUSD goes straight to this address. It's your connected wallet unless you change it."
      >
        <Input
          id="payout"
          value={payout}
          onChange={(e) => setPayout(e.target.value.trim())}
          spellCheck={false}
          autoComplete="off"
          className="font-mono text-[0.8125rem]"
          {...inputErrorProps("payout", error)}
        />
      </Field>

      {isDeployed ? (
        <>
          <TxPanel
            state={tx.state}
            onRetryRecord={tx.retryRecord}
            description={
              <>
                You&apos;re registering this wallet as a merchant on Mezo Testnet. Payouts go to{" "}
                <span className="font-mono text-foreground">{valid ? shortAddress(payout) : "your payout wallet"}</span>. This costs a small network fee in
                BTC.
              </>
            }
          />
          <div className="flex flex-wrap gap-2">
            {tx.state.phase === "success" && tx.state.recordError ? (
              <Button onClick={onDone}>Continue</Button>
            ) : (
              <Button onClick={register} disabled={!valid || tx.isBusy || !w.isReady}>
                {tx.isBusy ? "Working…" : !w.isReady ? "Switch to Mezo Testnet first" : "Register on-chain"}
              </Button>
            )}
          </div>
        </>
      ) : (
        <NotDeployedNotice />
      )}
    </div>
  );
}

export function Onboarding({ merchant, onFinish }: { merchant: MerchantDTO | null; onFinish: () => void }) {
  const [editing, setEditing] = useState(false);
  const [registered, setRegistered] = useState(false);
  const isRegistered = registered || (merchant !== null && merchant.chainStatus !== "pending");
  const step: 0 | 1 | 2 = isRegistered ? 2 : merchant && !editing ? 1 : 0;

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6 sm:py-14">
      <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">Set up your merchant account</h1>
      <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
        Three short steps. Subscribers pay you in MUSD, straight from their wallet to yours.
      </p>
      <div className="mt-6">
        <StepIndicator step={step} />
      </div>

      <div className="mt-8 rounded-xl border bg-card p-5 shadow-panel sm:p-6">
        {step === 0 ? (
          <>
            <h2 className="text-lg font-semibold">Your business</h2>
            <p className="mt-1 mb-5 text-sm text-muted-foreground">This is what subscribers see on your checkout page. You can change it later.</p>
            <ProfileForm
              merchant={merchant}
              method={merchant ? "PATCH" : "POST"}
              submitLabel={merchant ? "Save and continue" : "Continue"}
              onSaved={() => setEditing(false)}
            />
          </>
        ) : step === 1 && merchant ? (
          <>
            <h2 className="text-lg font-semibold">Register on Mezo</h2>
            <p className="mt-1 mb-5 text-sm text-muted-foreground">One transaction links your wallet to MezoSub so you can publish plans and get paid.</p>
            <RegisterStep merchant={merchant} onEdit={() => setEditing(true)} onDone={() => setRegistered(true)} />
          </>
        ) : (
          <>
            <h2 className="text-lg font-semibold">You&apos;re registered</h2>
            <p className="mt-1 mb-5 text-sm text-muted-foreground">Create a plan to get a checkout link you can share.</p>
            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/merchant/plans/new" onClick={onFinish}>
                  Create your first plan
                </Link>
              </Button>
              <Button asChild variant="ghost">
                <Link href="/merchant" onClick={onFinish}>
                  Go to dashboard
                </Link>
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
