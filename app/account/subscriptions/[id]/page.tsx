import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SubscriptionDetail } from "@/components/subscriptions/subscription-detail";

export const metadata = { title: "Subscription" };

export default async function AccountSubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <Link href="/account" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" aria-hidden /> My subscriptions
      </Link>
      <SubscriptionDetail id={id} viewer="subscriber" />
    </div>
  );
}
