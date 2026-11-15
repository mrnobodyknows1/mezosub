"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useConfig } from "wagmi";
import { readContract, signTypedData } from "@wagmi/core";
import type { Address, Hash, Hex } from "viem";
import { CircleCheck, ExternalLink, Globe, Mail } from "lucide-react";
import type { CheckoutDTO, SubscriptionDTO } from "@/lib/api-types";
import { erc20Abi } from "@/lib/chain/abis";
import { contracts, explorerTx, isDeployed, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { api, isNotFound } from "@/lib/client/api";
import { MAX_UINT128 } from "@/lib/client/authorization";
import { authorizationSentence, checkoutForReturning, checkoutSpendCap, planAuthorization } from "@/lib/client/checkout";
import { describeTxError } from "@/lib/client/errors";
import { formatBillingDate, musd } from "@/lib/client/format";
import { permitDeadline, permitDomainMatches, permitTypedData, splitPermitSignature } from "@/lib/client/permit";

const domainSeparatorAbi = [
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
] as const;
import { SITE } from "@/lib/client/site";
import { expiryFromDateInput, isPastExpiry, todayInput } from "@/lib/client/subscriptions";
import { build } from "@/lib/client/writes";
import { useCheckout } from "@/hooks/use-api";
import { useMounted } from "@/hooks/use-mounted";
import { useActiveSubscriptionOf, useHasSubscribed, useMusdBalance } from "@/hooks/use-musd";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { Logo } from "@/components/brand/logo";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { TxPanel } from "@/components/shared/tx-panel";
import { NotDeployedNotice } from "@/components/shared/not-deployed";
import { QueryError } from "@/components/shared/query-error";
import { ConnectDialog } from "@/components/wallet/connect-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { CheckoutSummary } from "./checkout-summary";

function MerchantIdentity({ c }: { c: CheckoutDTO }) {
  const m = c.merchant;
  return (
    <div className="flex items-start gap-3">
      {m.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={m.logoUrl} alt="" className="size-12 shrink-0 rounded-xl border object-cover" />
      ) : (
        <div aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-muted text-lg font-semibold">
          {m.name.slice(0, 1).toUpperCase()}
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{m.name}</p>
        <h1 className="text-2xl font-semibold tracking-[-0.02em] sm:text-3xl">{c.plan.name}</h1>
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[0.8125rem] text-muted-foreground">
          {m.website ? (
            <a href={m.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
              <Globe className="size-3.5" aria-hidden /> {m.website.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
          ) : null}
          {m.supportEmail ? (
            <a href={`mailto:${m.supportEmail}`} className="inline-flex items-center gap-1 hover:text-foreground">
              <Mail className="size-3.5" aria-hidden /> {m.supportEmail}
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SuccessScreen({ c, result, hash }: { c: CheckoutDTO; result: SubscriptionDTO | null; hash: Hash }) {
  const trial = c.plan.trialSeconds > 0;
  return (
    <div className="mx-auto w-full max-w-lg px-4 py-14 sm:py-20">
      <CircleCheck className="size-10 text-ok" strokeWidth={1.5} aria-hidden />
      <h1 className="mt-4 text-3xl font-semibold tracking-[-0.02em]">You&apos;re subscribed</h1>
      <p className="mt-2 text-muted-foreground">
        {c.plan.name} from {c.merchant.name}.
      </p>
      <dl className="mt-8 divide-y rounded-xl border text-sm">
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-muted-foreground">Charged today</dt>
          <dd className="num font-medium">{trial ? "Nothing, your trial has started" : `${musd(c.firstCharge.amount)} MUSD`}</dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-muted-foreground">Next payment</dt>
          <dd className="num text-right font-medium">
            {musd(result?.amountDue ?? (trial ? c.firstCharge.amount : c.secondCharge.amount))} MUSD
            <span className="block text-xs font-normal text-muted-foreground">
              {formatBillingDate(result?.nextBillingAt ?? (trial ? c.firstCharge.at : c.secondCharge.at), c.plan.billingInterval)}
            </span>
          </dd>
        </div>
        <div className="flex justify-between gap-4 px-4 py-3">
          <dt className="text-muted-foreground">Transaction</dt>
          <dd>
            <a href={explorerTx(hash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline-offset-4 hover:underline">
              View on explorer <ExternalLink className="size-3.5" aria-hidden />
            </a>
          </dd>
        </div>
      </dl>
      <p className="mt-6 text-sm text-muted-foreground">You can cancel anytime from your account.</p>
      <div className="mt-6 flex flex-wrap gap-2">
        <Button asChild>
          <Link href={result ? `/account/subscriptions/${result.id}` : "/account"}>Manage subscription</Link>
        </Button>
        <Button asChild variant="outline">
          <Link href="/account">All my subscriptions</Link>
        </Button>
      </div>
    </div>
  );
}

function ActionPanel({
  c,
  spendCap,
  expiresAt,
  blocked = false,
  onDone,
}: {
  c: CheckoutDTO;
  spendCap: bigint;
  expiresAt: bigint;
  /** e.g. an end date in the past: the subscribe button stays disabled */
  blocked?: boolean;
  onDone: (hash: Hash, dto: SubscriptionDTO | null) => void;
}) {
  const mounted = useMounted();
  const config = useConfig();
  const w = useWallet();
  const tx = useTx();
  const [connectOpen, setConnectOpen] = useState(false);
  const owner = w.address as Address | undefined;
  const planId = c.plan.onchainPlanId ? BigInt(c.plan.onchainPlanId) : undefined;
  const balance = useMusdBalance(owner);
  const existing = useActiveSubscriptionOf(planId, owner);
  const firstCharge = BigInt(c.firstCharge.amount);
  const chargesNow = c.plan.trialSeconds === 0;
  const lowBalance = balance.data !== undefined && balance.data < (chargesNow ? firstCharge : BigInt(c.plan.price));

  const sentence = authorizationSentence({ spendCap, price: c.plan.price, intervalSeconds: c.plan.billingInterval, merchantName: c.merchant.name });

  if (!isDeployed) return <NotDeployedNotice />;
  if (!planId || !c.live.acceptingSubscribers) {
    return (
      <div role="status" className="rounded-lg border px-4 py-3 text-sm">
        <p className="font-medium">This plan isn&apos;t taking new subscribers</p>
        <p className="mt-0.5 text-muted-foreground">{c.live.reason ?? "Check back later or contact the merchant."}</p>
      </div>
    );
  }
  if (!mounted) return <Skeleton className="h-11 w-full" />;
  if (!w.isConnected || !owner) {
    return (
      <div className="space-y-3">
        <Button size="lg" className="w-full" onClick={() => setConnectOpen(true)}>
          Connect wallet
        </Button>
        <p className="text-center text-[0.8125rem] text-muted-foreground">Use any EVM wallet on Mezo Testnet.</p>
        <ConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </div>
    );
  }
  if (w.network.kind === "wrong-network") {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">Your wallet is on another network. Switch to Mezo Testnet to continue. If it isn&apos;t in your wallet yet, it will be added.</p>
        <Button
          size="lg"
          className="w-full"
          disabled={w.isSwitching}
          onClick={() => w.switchToMezo().catch((e) => tx.fail("Switch network", e))}
        >
          {w.isSwitching ? "Switching…" : "Switch to Mezo Testnet"}
        </Button>
        <TxPanel state={tx.state} />
      </div>
    );
  }
  if (existing.data && existing.data > 0n && tx.state.phase === "idle") {
    return (
      <div className="space-y-3 rounded-lg border px-4 py-3 text-sm">
        <p className="font-medium">You already subscribe to this plan with this wallet.</p>
        <Button asChild variant="outline" size="sm">
          <Link href="/account">Go to my subscriptions</Link>
        </Button>
      </div>
    );
  }

  async function subscribe() {
    if (!owner || planId === undefined) return;
    const termsVersion = c.live.termsVersion;
    let doneHash: Hash | null = null;
    let dto: SubscriptionDTO | null = null;
    const record = async (hash: Hash) => {
      doneHash = hash;
      dto = await api<SubscriptionDTO>("/api/subscriptions/confirm", { method: "POST", json: { txHash: hash } });
    };

    let allowance: bigint;
    try {
      allowance = await readContract(config, {
        address: contracts.musd,
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner, contracts.manager],
        chainId: MEZO_TESTNET_ID,
      });
    } catch (e) {
      tx.fail("Subscribe", e);
      return;
    }
    const plan = planAuthorization(allowance, spendCap);

    let finished: Awaited<ReturnType<typeof tx.run>> = null;
    if (plan.mode === "direct") {
      finished = await tx.run(build.subscribe(planId, termsVersion, spendCap, expiresAt), { record, successMessage: "Subscribed" });
    } else {
      let permit: { v: number; r: Hex; s: Hex; deadline: bigint } | null = null;
      // Passport Bitcoin wallets sign through a Mezo smart account (ERC-1271). MUSD's permit only accepts an
      // ECDSA signature from the owner, so those wallets go straight to approve + subscribe.
      if (!w.isSmartAccount) try {
        const [tokenName, nonce, separator] = await Promise.all([
          readContract(config, { address: contracts.musd, abi: erc20Abi, functionName: "name", chainId: MEZO_TESTNET_ID }),
          readContract(config, { address: contracts.musd, abi: erc20Abi, functionName: "nonces", args: [owner], chainId: MEZO_TESTNET_ID }),
          readContract(config, { address: contracts.musd, abi: domainSeparatorAbi, functionName: "DOMAIN_SEPARATOR", chainId: MEZO_TESTNET_ID }),
        ]);
        // If our typed-data domain doesn't match the token's, the permit would be swallowed on-chain and the
        // subscribe would revert. Use the approve path instead (no wasted signature).
        if (!permitDomainMatches({ tokenName, token: contracts.musd, onchainSeparator: separator })) throw new Error("permit domain mismatch");
        const deadline = permitDeadline();
        const typed = permitTypedData({ tokenName, token: contracts.musd, owner, spender: contracts.manager, value: plan.value, nonce, deadline });
        const sig = await tx.sign("Sign spending permission", () => signTypedData(config, { account: owner, ...typed }), "Step 1 of 2");
        permit = { ...splitPermitSignature(sig), deadline };
      } catch (e) {
        if (describeTxError(e).kind === "rejected") {
          tx.fail("Sign spending permission", e);
          return;
        }
        permit = null; // wallet can't sign typed data: fall back to approve + subscribe
      }
      if (permit) {
        finished = await tx.run(
          build.subscribeWithPermit(planId, termsVersion, spendCap, expiresAt, plan.value, permit.deadline, permit.v, permit.r, permit.s),
          { record, progress: "Step 2 of 2", successMessage: "Subscribed" },
        );
      } else {
        const a = await tx.run(build.approveMusd(plan.value), { silent: true, intermediate: true, progress: "Step 1 of 2" });
        if (!a) return;
        finished = await tx.run(build.subscribe(planId, termsVersion, spendCap, expiresAt), { record, progress: "Step 2 of 2", successMessage: "Subscribed" });
      }
    }
    if (finished && doneHash) onDone(finished.hash, dto);
  }

  const capInvalid = spendCap < firstCharge || spendCap > MAX_UINT128;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">Your MUSD balance</span>
        <span className="num font-medium">{balance.isLoading ? "…" : `${musd(balance.data)} MUSD`}</span>
      </div>
      {lowBalance ? (
        <div role="status" className="rounded-lg border border-warn/40 bg-warn/5 px-3 py-2.5 text-sm">
          <p>
            {chargesNow ? `You need at least ${musd(firstCharge)} MUSD for the first payment.` : "Your balance is lower than one payment. Top up before the trial ends."}
          </p>
          <a href={SITE.faucetUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 font-medium underline underline-offset-4">
            Get testnet MUSD <ExternalLink className="size-3.5" aria-hidden />
          </a>
        </div>
      ) : null}
      <TxPanel
        state={tx.state}
        onRetryRecord={tx.retryRecord}
        description={
          <div className="space-y-2">
            <p className="text-foreground">{sentence}</p>
            {w.isSmartAccount ? (
              <p>
                Your wallet asks you to approve MUSD first, then sends one transaction that starts the subscription
                {chargesNow ? ` and takes the first ${musd(firstCharge)} MUSD.` : ". Nothing is charged until the trial ends."}
              </p>
            ) : (
              <p>
                Your wallet asks for a free signature first, then one transaction that starts the subscription
                {chargesNow ? ` and takes the first ${musd(firstCharge)} MUSD.` : ". Nothing is charged until the trial ends."} If your wallet can&apos;t sign,
                it asks you to approve MUSD instead.
              </p>
            )}
          </div>
        }
      />
      {tx.state.phase === "success" && tx.state.recordError ? null : (
        <Button
          size="lg"
          className="w-full"
          disabled={tx.isBusy || capInvalid || blocked || (chargesNow && lowBalance)}
          onClick={() => void subscribe()}
        >
          {tx.isBusy ? "Working…" : tx.state.phase === "error" ? "Try again" : "Authorize and subscribe"}
        </Button>
      )}
      {tx.state.phase === "success" && tx.state.hash ? (
        <Button size="lg" variant="outline" className="w-full" onClick={() => onDone(tx.state.hash as Hash, null)}>
          Continue
        </Button>
      ) : null}
    </div>
  );
}

export function CheckoutView({ slug }: { slug: string }) {
  const ids = useId();
  const q = useCheckout(slug);
  const [periodsInput, setPeriodsInput] = useState<number | null>(null);
  const [expiry, setExpiry] = useState("");
  const [done, setDone] = useState<{ hash: Hash; dto: SubscriptionDTO | null } | null>(null);
  const wallet = useWallet();
  const onchainPlanId = q.data?.plan.onchainPlanId ? BigInt(q.data.plan.onchainPlanId) : undefined;
  const returning = useHasSubscribed(onchainPlanId, wallet.address as Address | undefined).data === true;

  if (q.isLoading) {
    return (
      <Shell>
        <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr]">
          <div className="space-y-4">
            <Skeleton className="h-12 w-72" />
            <Skeleton className="h-10 w-48" />
            <Skeleton className="h-56 w-full rounded-xl" />
          </div>
          <Skeleton className="h-72 w-full rounded-xl" />
        </div>
      </Shell>
    );
  }
  if (q.error || !q.data) {
    return (
      <Shell>
        {isNotFound(q.error) ? (
          <div className="max-w-md">
            <h1 className="text-2xl font-semibold tracking-[-0.02em]">This plan isn&apos;t available</h1>
            <p className="mt-2 text-muted-foreground">The link may be wrong, or the merchant removed the plan.</p>
            <Button asChild variant="outline" className="mt-6">
              <Link href="/">Go to MezoSub</Link>
            </Button>
          </div>
        ) : (
          <QueryError error={q.error} onRetry={() => void q.refetch()} title="Couldn't load this plan" />
        )}
      </Shell>
    );
  }

  const hadOffer = q.data.plan.trialSeconds > 0 || q.data.plan.introPeriods > 0;
  const c = returning && hadOffer ? checkoutForReturning(q.data) : q.data;
  if (done) {
    return (
      <Shell>
        <SuccessScreen c={c} result={done.dto} hash={done.hash} />
      </Shell>
    );
  }

  const periods = Math.max(1, Math.min(520, Math.floor(periodsInput ?? c.suggestedPeriods) || 1));
  const spendCap = checkoutSpendCap(c, periods);
  const expiresAt = expiryFromDateInput(expiry);
  const expiryInPast = isPastExpiry(expiresAt);

  return (
    <Shell>
      <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-14">
        <div className="space-y-8">
          <MerchantIdentity c={c} />
          {c.plan.description ? <p className="max-w-[60ch] text-muted-foreground">{c.plan.description}</p> : null}
          {c.plan.features.length ? (
            <ul className="grid gap-2 text-sm sm:grid-cols-2">
              {c.plan.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <CircleCheck className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden />
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {returning && hadOffer ? (
            <p className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
              You subscribed to this plan before, so the trial and intro price don&apos;t apply. The first payment is the full price.
            </p>
          ) : null}
          <CheckoutSummary checkout={c} spendCap={spendCap} periods={periods} expiresAt={expiryInPast ? 0n : expiresAt} />
        </div>

        <div className="lg:sticky lg:top-6 lg:self-start">
          <section aria-labelledby={`${ids}-auth`} className="space-y-5 rounded-xl border bg-card p-5 shadow-panel sm:p-6">
            <div>
              <h2 id={`${ids}-auth`} className="text-lg font-semibold">
                Set your spending limit
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">MezoSub can never charge more than this in total. You can renew it later.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor={`${ids}-periods`}>Number of payments</Label>
                <Input
                  id={`${ids}-periods`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={520}
                  value={periodsInput ?? c.suggestedPeriods}
                  onChange={(e) => setPeriodsInput(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : null)}
                />
                <p className="num text-xs text-muted-foreground">Limit: {musd(spendCap)} MUSD</p>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={`${ids}-exp`}>End date (optional)</Label>
                <Input id={`${ids}-exp`} type="date" min={todayInput(1)} value={expiry} onChange={(e) => setExpiry(e.target.value)} />
                {expiryInPast ? <p className="text-xs text-bad">Pick a date in the future.</p> : <p className="text-xs text-muted-foreground">Payments stop after this date.</p>}
              </div>
            </div>
            <ActionPanel c={c} spendCap={spendCap} expiresAt={expiryInPast ? 0n : expiresAt} blocked={expiryInPast} onDone={(hash, dto) => setDone({ hash, dto })} />
          </section>
        </div>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link href="/" aria-label="MezoSub home" className="rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            <Logo className="text-sm" />
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6 sm:py-14">
        {children}
      </main>
      <footer className="border-t">
        <p className="mx-auto w-full max-w-6xl px-4 py-5 text-[0.8125rem] text-muted-foreground sm:px-6">
          Billing by MezoSub on Mezo Testnet. Testnet tokens have no value.
        </p>
      </footer>
    </div>
  );
}
