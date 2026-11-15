import type { Metadata } from "next";
import { CheckoutView } from "@/components/checkout/checkout-view";

export const metadata: Metadata = {
  title: "Subscribe",
  description: "Review the plan, set your spending limit and subscribe with MUSD on Mezo.",
  robots: { index: false, follow: false },
};

export default async function SubscribePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CheckoutView slug={slug} />;
}
