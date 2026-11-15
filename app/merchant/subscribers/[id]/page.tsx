import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { SubscriptionDetail } from "@/components/subscriptions/subscription-detail";

export default async function MerchantSubscriptionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <div className="space-y-6">
      <Link
        href="/merchant/subscribers"
        className="inline-flex items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft className="size-4" aria-hidden /> Subscribers
      </Link>
      <SubscriptionDetail id={id} viewer="merchant" />
    </div>
  );
}
