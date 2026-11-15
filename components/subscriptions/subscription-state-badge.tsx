import type { DerivedSubscriptionState } from "@/lib/chain/subscription-state";
import { subscriptionStateMeta } from "@/lib/client/status";
import { StatusBadge } from "@/components/shared/status-badge";

export function SubscriptionStateBadge({ state, className }: { state: DerivedSubscriptionState; className?: string }) {
  return <StatusBadge meta={subscriptionStateMeta(state)} className={className} />;
}
