"use client";

import { useId, useState } from "react";
import { toast } from "sonner";
import { useConfig } from "wagmi";
import { readContract } from "@wagmi/core";
import type { Address } from "viem";
import type { SubscriptionDTO } from "@/lib/api-types";
import { erc20Abi } from "@/lib/chain/abis";
import { contracts, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { allowanceTarget, capForPeriods, MAX_UINT128 } from "@/lib/client/authorization";
import { errorMessage } from "@/lib/client/api";
import { formatDate, musd, perInterval } from "@/lib/client/format";
import { build } from "@/lib/client/writes";
import { dateInputFromIso, expiryFromDateInput, isPastExpiry, retrySubscription, syncSubscription, termsOf, todayInput } from "@/lib/client/subscriptions";
import { tryParseMusd } from "@/lib/money";
import { useWallet } from "@/hooks/use-wallet";
import { ActionDialog } from "@/components/shared/action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Size = "sm" | "default";

/** Cancel (subscriber or merchant). Terminal on-chain. */
export function CancelSubscriptionAction({ sub, viewer, size = "sm" }: { sub: SubscriptionDTO; viewer: "merchant" | "subscriber"; size?: Size }) {
  return (
    <ActionDialog
      trigger={<Button variant="outline" size={size}>Cancel subscription</Button>}
      title="Cancel this subscription?"
      body={
        viewer === "subscriber"
          ? `${sub.merchant.name} won't be able to charge you again for ${sub.plan.name}. Past payments aren't reversed automatically.`
          : `This subscriber won't be charged again for ${sub.plan.name}. Past payments aren't reversed automatically. You can refund separately.`
      }
      walletAsk="Your wallet will send one transaction that cancels the subscription on-chain. You pay a small network fee in BTC."
      confirmLabel="Cancel subscription"
      destructive
      onConfirm={async (tx) => {
        const r = await tx.run(build.cancelSubscription(BigInt(sub.onchainSubscriptionId)), {
          record: (hash) => syncSubscription(sub.id, hash),
          successMessage: "Subscription cancelled",
        });
        return Boolean(r);
      }}
    />
  );
}

/** Renew / restore authorization: new absolute spending limit and optional end date. Subscriber only. */
export function RenewAuthorizationAction({ sub, size = "sm", variant = "default" }: { sub: SubscriptionDTO; size?: Size; variant?: "default" | "outline" }) {
  const ids = useId();
  const [periods, setPeriods] = useState(12);
  const [expiry, setExpiry] = useState(dateInputFromIso(sub.expiresAt));
  const terms = termsOf(sub);
  const p = Number.isFinite(periods) ? Math.max(0, Math.min(520, Math.floor(periods))) : 0;
  const cap = capForPeriods(terms, p, sub.paymentsCount);
  const expiresAt = expiryFromDateInput(expiry);
  const expiryInPast = isPastExpiry(expiresAt);
  const invalid = p < 1 || cap > MAX_UINT128 || expiryInPast;

  return (
    <ActionDialog
      trigger={<Button variant={variant} size={size}>Renew authorization</Button>}
      title="Renew authorization"
      body={`Set a new spending limit for ${sub.plan.name}. It replaces what's left of the current one.`}
      walletAsk={
        <>
          You&apos;re allowing MezoSub to charge up to <strong className="num text-foreground">{musd(cap)} MUSD</strong> in total,{" "}
          <span className="num">{musd(sub.amount)}</span> MUSD {perInterval(sub.billingInterval)}, to {sub.merchant.name}. Nothing else.
        </>
      }
      confirmLabel="Renew"
      disabled={invalid}
      onConfirm={async (tx) => {
        const r = await tx.run(build.updateAuthorization(BigInt(sub.onchainSubscriptionId), cap, expiresAt), {
          record: (hash) => syncSubscription(sub.id, hash),
          successMessage: "Authorization renewed",
        });
        return Boolean(r);
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-periods`}>Number of payments</Label>
          <Input
            id={`${ids}-periods`}
            type="number"
            inputMode="numeric"
            min={1}
            max={520}
            value={Number.isFinite(periods) ? periods : ""}
            onChange={(e) => setPeriods(e.target.valueAsNumber)}
          />
          <p className="num text-xs text-muted-foreground">Limit: {musd(cap)} MUSD</p>
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`${ids}-exp`}>End date (optional)</Label>
          <Input id={`${ids}-exp`} type="date" min={todayInput(1)} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
          {expiryInPast ? <p className="text-xs text-bad">Pick a date in the future.</p> : <p className="text-xs text-muted-foreground">Leave empty for no end date.</p>}
        </div>
      </div>
    </ActionDialog>
  );
}

/** Revoke: limit to zero + cancel. The ERC-20 allowance is separate (see RemoveAllowanceAction). */
export function RevokeAuthorizationAction({ sub, size = "sm" }: { sub: SubscriptionDTO; size?: Size }) {
  return (
    <ActionDialog
      trigger={<Button variant="ghost" size={size}>Revoke authorization</Button>}
      title="Revoke authorization?"
      body="This sets the spending limit for this subscription to zero and cancels it. Your MUSD allowance for MezoSub stays as it is; you can remove it separately under Allowance."
      walletAsk="Your wallet will send one transaction that revokes this subscription's authorization. You pay a small network fee in BTC."
      confirmLabel="Revoke"
      destructive
      onConfirm={async (tx) => {
        const r = await tx.run(build.revokeAuthorization(BigInt(sub.onchainSubscriptionId)), {
          record: (hash) => syncSubscription(sub.id, hash),
          successMessage: "Authorization revoked",
        });
        return Boolean(r);
      }}
    />
  );
}

/** Set the MUSD allowance for the SubscriptionManager to an absolute amount. */
export function SetAllowanceAction({
  target,
  current,
  label,
  size = "sm",
  variant = "default",
}: {
  target: bigint;
  current: bigint;
  label?: string;
  size?: Size;
  variant?: "default" | "outline";
}) {
  return (
    <ActionDialog
      trigger={<Button variant={variant} size={size}>{label ?? "Increase allowance"}</Button>}
      title="Increase MUSD allowance"
      body={`Current allowance: ${musd(current)} MUSD. New allowance: ${musd(target)} MUSD.`}
      walletAsk={
        <>
          You&apos;re allowing MezoSub&apos;s contract to move up to <strong className="num text-foreground">{musd(target)} MUSD</strong> from your wallet in
          total, across all your subscriptions. Each subscription still can&apos;t go over its own limit.
        </>
      }
      confirmLabel="Approve"
      onConfirm={async (tx) => {
        const r = await tx.run(build.approveMusd(target, "Increase MUSD allowance"), { successMessage: "Allowance updated" });
        return Boolean(r);
      }}
    />
  );
}

/** approve(manager, 0): stops MezoSub from moving any MUSD, for every subscription. */
export function RemoveAllowanceAction({ size = "sm" }: { size?: Size }) {
  return (
    <ActionDialog
      trigger={<Button variant="ghost" size={size}>Remove allowance</Button>}
      title="Remove MUSD allowance?"
      body="MezoSub's contract won't be able to move any MUSD from this wallet. Every active subscription will start failing until you approve again. Cancel or revoke subscriptions separately if you want them to stop."
      walletAsk="Your wallet will send one transaction that sets MezoSub's MUSD allowance to zero."
      confirmLabel="Remove allowance"
      destructive
      onConfirm={async (tx) => {
        const r = await tx.run(build.approveMusd(0n), { successMessage: "Allowance removed" });
        return Boolean(r);
      }}
    />
  );
}

/** Re-queue a failed collection now (no chain write). */
export function RetryNowButton({ id, size = "sm", variant = "outline" }: { id: string; size?: Size; variant?: "default" | "outline" }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size={size}
      variant={variant}
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await retrySubscription(id);
          toast.success("Retry queued", { description: "MezoSub will try to collect again shortly." });
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

/** Merchant: collect a due payment from the merchant wallet. */
export function CollectNowAction({ sub, size = "sm" }: { sub: SubscriptionDTO; size?: Size }) {
  return (
    <ActionDialog
      trigger={<Button size={size}>Collect due payment</Button>}
      title="Collect due payment"
      body={`${musd(sub.amountDue)} MUSD for ${sub.plan.name}, due since ${formatDate(sub.nextBillingAt)}.`}
      walletAsk={`Your wallet will send one transaction. The contract moves ${musd(sub.amountDue)} MUSD from the subscriber to your payout wallet. You pay a small network fee in BTC.`}
      confirmLabel="Collect"
      onConfirm={async (tx) => {
        const r = await tx.run(build.collectPayment(BigInt(sub.onchainSubscriptionId)), {
          record: (hash) => syncSubscription(sub.id, hash),
          successMessage: "Payment collected",
        });
        return Boolean(r);
      }}
    />
  );
}

/** Merchant: refund from the merchant's own wallet (needs a MUSD allowance to the manager). */
export function RefundAction({ sub, size = "sm" }: { sub: SubscriptionDTO; size?: Size }) {
  const ids = useId();
  const config = useConfig();
  const w = useWallet();
  const refundable = BigInt(sub.totalPaid) - BigInt(sub.totalRefunded);
  const [value, setValue] = useState("");
  const amount = tryParseMusd(value);
  const error =
    value === "" ? null : amount === null || amount <= 0n ? "Enter an amount above zero." : amount > refundable ? `You can refund up to ${musd(refundable)} MUSD.` : null;

  if (refundable <= 0n) return null;
  return (
    <ActionDialog
      trigger={<Button variant="outline" size={size}>Refund</Button>}
      title="Refund this subscriber"
      body={`Refunds come from your connected wallet, not from the contract. Up to ${musd(refundable)} MUSD can be refunded.`}
      walletAsk="If your MUSD allowance for MezoSub is too low, your wallet first asks you to approve the refund amount. Then it sends the refund transaction."
      confirmLabel="Refund"
      disabled={amount === null || amount <= 0n || Boolean(error)}
      onConfirm={async (tx) => {
        if (!amount || !w.address) return false;
        let allowance: bigint;
        try {
          allowance = await readContract(config, {
            address: contracts.musd,
            abi: erc20Abi,
            functionName: "allowance",
            args: [w.address as Address, contracts.manager],
            chainId: MEZO_TESTNET_ID,
          });
        } catch (e) {
          tx.fail("Refund", e);
          return false;
        }
        if (allowance < amount) {
          const target = allowanceTarget(allowance, amount);
          if (target !== null) {
            const a = await tx.run(build.approveMusd(target, "Approve refund amount"), { silent: true, intermediate: true, progress: "Step 1 of 2" });
            if (!a) return false;
          }
        }
        const r = await tx.run(build.refund(BigInt(sub.onchainSubscriptionId), amount), {
          record: (hash) => syncSubscription(sub.id, hash),
          successMessage: "Refund sent",
          progress: allowance < amount ? "Step 2 of 2" : undefined,
        });
        return Boolean(r);
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`${ids}-amt`}>Amount (MUSD)</Label>
        <Input
          id={`${ids}-amt`}
          inputMode="decimal"
          autoComplete="off"
          placeholder={musd(refundable)}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-invalid={Boolean(error)}
        />
        {error ? <p className="text-xs text-bad">{error}</p> : null}
      </div>
    </ActionDialog>
  );
}
