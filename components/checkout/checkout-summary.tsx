import type { CheckoutDTO } from "@/lib/api-types";
import { explorerAddress } from "@/lib/chain/config";
import { formatBillingDate, intervalNoun, isDemoInterval, musd, perInterval, pluralize, shortAddress, trialLabel } from "@/lib/client/format";

/**
 * What the subscriber is agreeing to, rendered from a CheckoutDTO plus the chosen limit.
 * Pure and presentational so it is unit tested with a fixture.
 */
export function CheckoutSummary({
  checkout,
  spendCap,
  periods,
  expiresAt,
}: {
  checkout: CheckoutDTO;
  spendCap: bigint;
  periods: number;
  /** unix seconds; 0n = no end date */
  expiresAt: bigint;
}) {
  const { plan, merchant } = checkout;
  const trial = trialLabel(plan.trialSeconds);
  const hasIntro = plan.introPeriods > 0 && plan.introPrice !== "0";
  const firstIsNow = plan.trialSeconds === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline gap-2">
        <span className="num text-4xl font-semibold tracking-[-0.03em]" data-testid="price">
          {musd(plan.price)}
        </span>
        <span className="text-muted-foreground">MUSD {perInterval(plan.billingInterval)}</span>
      </div>
      {isDemoInterval(plan.billingInterval) ? (
        <p className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm">
          Testnet demo: this plan bills every 5 minutes so you can watch renewals happen.
        </p>
      ) : null}
      {trial || hasIntro ? (
        <p className="text-sm">
          {trial ? <span>{trial}. </span> : null}
          {hasIntro ? (
            <span>
              <span className="num">{musd(plan.introPrice)}</span> MUSD for the first {pluralize(plan.introPeriods, intervalNoun(plan.billingInterval) === "5 minutes" ? "payment" : intervalNoun(plan.billingInterval))}.
            </span>
          ) : null}
        </p>
      ) : null}

      <dl className="divide-y rounded-xl border text-sm">
        <Row label={firstIsNow ? "Charged today" : "First payment"}>
          <span className="num font-medium" data-testid="first-charge">
            {musd(checkout.firstCharge.amount)} MUSD
          </span>
          {!firstIsNow ? <span className="num block text-xs text-muted-foreground">{formatBillingDate(checkout.firstCharge.at, plan.billingInterval)}</span> : null}
        </Row>
        <Row label="Next payment">
          <span className="num font-medium">{musd(checkout.secondCharge.amount)} MUSD</span>
          <span className="num block text-xs text-muted-foreground" data-testid="second-charge-date">
            {formatBillingDate(checkout.secondCharge.at, plan.billingInterval)}
          </span>
        </Row>
        <Row label="Spending limit">
          <span className="num font-medium" data-testid="spend-cap">
            {musd(spendCap)} MUSD
          </span>
          <span className="block text-xs text-muted-foreground">Covers {pluralize(periods, "payment")}</span>
        </Row>
        <Row label="Ends">
          <span className="font-medium">{expiresAt === 0n ? "No end date" : formatBillingDate(new Date(Number(expiresAt) * 1000).toISOString(), plan.billingInterval)}</span>
        </Row>
        <Row label="Paid to">
          <span className="font-medium">{merchant.name}</span>
          {merchant.payoutAddress ? <span className="block font-mono text-xs text-muted-foreground">{shortAddress(merchant.payoutAddress)}</span> : null}
        </Row>
      </dl>

      <div className="space-y-1.5 text-sm">
        <p className="font-medium">Cancel anytime. Past payments aren&apos;t reversed automatically.</p>
        <p className="text-muted-foreground">
          Payments go straight from your wallet to {merchant.name}. MezoSub never holds your MUSD and can&apos;t charge more than the limit you set.
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[0.8125rem] text-muted-foreground sm:grid-cols-2">
        <div>
          <dt className="inline">Network: </dt>
          <dd className="inline">Mezo Testnet ({checkout.chainId}). Fees paid in BTC.</dd>
        </div>
        <div>
          <dt className="inline">Token: </dt>
          <dd className="inline">
            <a className="underline-offset-4 hover:underline" href={explorerAddress(plan.tokenAddress)} target="_blank" rel="noreferrer">
              {plan.tokenSymbol} <span className="font-mono">{shortAddress(plan.tokenAddress)}</span>
            </a>
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="inline">Contract: </dt>
          <dd className="inline">
            <a className="underline-offset-4 hover:underline" href={explorerAddress(checkout.managerAddress)} target="_blank" rel="noreferrer">
              <span className="font-mono">{shortAddress(checkout.managerAddress)}</span>
            </a>
          </dd>
        </div>
      </dl>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}
