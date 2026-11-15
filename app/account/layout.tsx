import type { Metadata } from "next";
import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { AuthGate } from "@/components/wallet/auth-gate";

export const metadata: Metadata = { title: "My subscriptions", robots: { index: false, follow: false } };

export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6">
        <AuthGate title="Sign in to see your subscriptions" body="Your wallet is your login. Signing in is free and doesn't send a transaction.">
          {children}
        </AuthGate>
      </main>
      <SiteFooter />
    </>
  );
}
