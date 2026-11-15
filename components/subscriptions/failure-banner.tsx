"use client";

import type { SubscriptionDTO } from "@/lib/api-types";
import { COLLECTION_REASONS } from "@/lib/client/errors";
import { formatDateTime } from "@/lib/client/format";
import { SITE } from "@/lib/client/site";
import { RenewAuthorizationAction, RetryNowButton, SetAllowanceAction } from "./subscription-actions";

/**
 * Explains why a subscription can't be charged, in plain words, and offers the fix.
 * Covers the last failed attempt plus derived states that block the next charge (expired, limit used up).
 */
export function FailureBanner({
  sub,
  viewer,
  allowance,
  committed,
}: {
  sub: SubscriptionDTO;
  viewer: "merchant" | "subscriber";
  /** Subscriber's current MUSD allowance to the manager and Σ committed caps (for the allowance fix). */
  allowance?: bigint;
  committed?: bigint;
}) {
  if (sub.status === "cancelled") return null;
  const reason =
    sub.lastFailure?.reason ?? (sub.state === "expired" ? "authorization_expired" : sub.state === "cap_exhausted" ? "spend_cap_exceeded" : null);
  if (!reason || reason === "ok" || reason === "not_due") return null;
  const info = COLLECTION_REASONS[reason];
  const fix = info.subscriberFix;
  const bad = sub.billingStatus === "past_due" || sub.state === "past_due";

  return (
    <div role="alert" className={`rounded-lg border px-4 py-3 text-sm ${bad ? "border-bad/35 bg-bad/5" : "border-warn/40 bg-warn/5"}`}>
      <p className="font-medium">
        {sub.lastFailure ? `Last payment failed: ${info.title.toLowerCase()}` : info.title}
      </p>
      <p className="mt-0.5 text-muted-foreground">
        {viewer === "subscriber" ? info.fix : fix ? "The subscriber needs to fix this. " + info.fix.replace("the wallet", "their wallet") : info.fix}
        {sub.lastFailure?.nextRetryAt ? ` Next automatic retry: ${formatDateTime(sub.lastFailure.nextRetryAt)}.` : ""}
      </p>
      {viewer === "subscriber" && fix ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {fix === "fund" ? (
            <a
              href={SITE.faucetUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-8 items-center rounded-md border px-2.5 text-[0.8rem] font-medium hover:bg-muted"
            >
              Get testnet MUSD
            </a>
          ) : null}
          {fix === "allowance" && allowance !== undefined ? (
            <SetAllowanceAction current={allowance} target={committed && committed > allowance ? committed : allowance + BigInt(sub.amountDue)} />
          ) : null}
          {fix === "renew" ? <RenewAuthorizationAction sub={sub} /> : null}
          {sub.lastFailure ? <RetryNowButton id={sub.id} /> : null}
        </div>
      ) : null}
      {viewer === "merchant" && sub.lastFailure ? (
        <div className="mt-3">
          <RetryNowButton id={sub.id} />
        </div>
      ) : null}
    </div>
  );
}
