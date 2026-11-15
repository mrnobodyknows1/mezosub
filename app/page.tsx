import { SiteHeader } from "@/components/site/site-header";
import { SiteFooter } from "@/components/site/site-footer";
import { Hero } from "@/components/landing/hero";
import { HowItWorks } from "@/components/landing/how-it-works";
import { Authorization } from "@/components/landing/authorization";
import { Network } from "@/components/landing/network";
import { UseCases } from "@/components/landing/use-cases";
import { DashboardPreview } from "@/components/landing/dashboard-preview";
import { ClosingCta } from "@/components/landing/closing-cta";

export default function Home() {
  return (
    <>
      <SiteHeader />
      <main id="main" className="flex-1">
        <Hero />
        <HowItWorks />
        <Authorization />
        <Network />
        <UseCases />
        <DashboardPreview />
        <ClosingCta />
      </main>
      <SiteFooter />
    </>
  );
}
