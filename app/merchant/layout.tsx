import type { Metadata } from "next";
import { MerchantShell } from "@/components/merchant/shell";

export const metadata: Metadata = {
  title: "Merchant dashboard",
  description: "Create MUSD subscription plans, share checkout links and manage subscribers on Mezo.",
  robots: { index: false, follow: false },
};

export default function MerchantLayout({ children }: { children: React.ReactNode }) {
  return <MerchantShell>{children}</MerchantShell>;
}
