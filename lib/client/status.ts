import type { BillingJobStatus, BillingStatus, MerchantChainStatus, PaymentDTO, PlanStatus } from "@/lib/api-types";
import type { DerivedSubscriptionState } from "@/lib/chain/subscription-state";

/** Semantic tone → token colour. Always shown together with a word, never colour alone. */
export type Tone = "ok" | "info" | "warn" | "bad" | "idle";

export interface StatusMeta {
  label: string;
  tone: Tone;
  /** One short sentence for tooltips / detail pages. */
  hint: string;
}

export const SUBSCRIPTION_STATE: Record<DerivedSubscriptionState, StatusMeta> = {
  trialing: { label: "Trial", tone: "info", hint: "Free trial. The first payment is taken when it ends." },
  active: { label: "Active", tone: "ok", hint: "Paid up. The next payment is scheduled." },
  due: { label: "Payment due", tone: "warn", hint: "A payment is due and can be collected now." },
  past_due: { label: "Past due", tone: "bad", hint: "Payment retries failed. The subscriber needs to fix funding." },
  expired: { label: "Expired", tone: "idle", hint: "The authorization end date has passed." },
  cap_exhausted: { label: "Limit reached", tone: "warn", hint: "The spending limit can't cover the next payment." },
  cancelled: { label: "Cancelled", tone: "idle", hint: "No further payments will be taken." },
};

export function subscriptionStateMeta(state: DerivedSubscriptionState): StatusMeta {
  return SUBSCRIPTION_STATE[state] ?? { label: state, tone: "idle", hint: "" };
}

export const BILLING_STATUS: Record<BillingStatus, StatusMeta> = {
  ok: { label: "OK", tone: "ok", hint: "Payments are going through." },
  retrying: { label: "Retrying", tone: "warn", hint: "The last payment failed and will be retried." },
  past_due: { label: "Past due", tone: "bad", hint: "All retries failed." },
};

export const PLAN_STATUS: Record<PlanStatus, StatusMeta> = {
  draft: { label: "Draft", tone: "idle", hint: "Not published on-chain yet." },
  active: { label: "Live", tone: "ok", hint: "Taking new subscribers." },
  paused: { label: "Paused", tone: "warn", hint: "No new subscribers. Existing ones keep billing." },
  archived: { label: "Archived", tone: "idle", hint: "Closed to new subscribers. Existing ones keep billing." },
};

export const MERCHANT_STATUS: Record<MerchantChainStatus, StatusMeta> = {
  pending: { label: "Not registered", tone: "idle", hint: "Finish registering on-chain." },
  active: { label: "Active", tone: "ok", hint: "Taking subscribers and collecting payments." },
  paused: { label: "Paused", tone: "warn", hint: "No new subscribers and no collections until you resume." },
  suspended: { label: "Suspended", tone: "bad", hint: "Suspended by the MezoSub operator." },
};

export const PAYMENT_STATUS: Record<PaymentDTO["status"], StatusMeta> = {
  succeeded: { label: "Paid", tone: "ok", hint: "Collected on-chain." },
  failed: { label: "Failed", tone: "bad", hint: "The collection attempt didn't go through." },
  refunded: { label: "Refunded", tone: "info", hint: "Refunded by the merchant." },
};

export const JOB_STATUS: Record<BillingJobStatus, StatusMeta> = {
  scheduled: { label: "Scheduled", tone: "info", hint: "Will be collected when due." },
  processing: { label: "Processing", tone: "info", hint: "Being collected now." },
  submitted: { label: "Submitted", tone: "info", hint: "Waiting for confirmation." },
  retrying: { label: "Retrying", tone: "warn", hint: "Failed, will retry." },
  succeeded: { label: "Collected", tone: "ok", hint: "Paid." },
  failed_final: { label: "Failed", tone: "bad", hint: "All retries failed." },
  skipped: { label: "Skipped", tone: "idle", hint: "Not collectible (cancelled, expired or limit reached)." },
  cancelled: { label: "Cancelled", tone: "idle", hint: "Subscription was cancelled." },
};

/** Tailwind classes per tone (text + soft background + border), shared by badges and banners. */
export const TONE_CLASS: Record<Tone, { text: string; bg: string; border: string; dot: string }> = {
  ok: { text: "text-ok", bg: "bg-ok/10", border: "border-ok/30", dot: "bg-ok" },
  info: { text: "text-info", bg: "bg-info/10", border: "border-info/30", dot: "bg-info" },
  warn: { text: "text-warn", bg: "bg-warn/10", border: "border-warn/35", dot: "bg-warn" },
  bad: { text: "text-bad", bg: "bg-bad/10", border: "border-bad/30", dot: "bg-bad" },
  idle: { text: "text-muted-foreground", bg: "bg-muted", border: "border-border", dot: "bg-idle" },
};
