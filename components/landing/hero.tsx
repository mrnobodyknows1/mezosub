import Link from "next/link";
import { Button } from "@/components/ui/button";
import { CheckoutPreview } from "./checkout-preview";
import { Reveal } from "./reveal";

export function Hero() {
  return (
    <section className="mx-auto grid w-full max-w-6xl items-center gap-12 px-4 pt-14 pb-20 sm:px-6 md:pt-20 lg:grid-cols-[1.1fr_1fr] lg:gap-16 lg:pt-24">
      <Reveal>
        <h1 className="text-4xl leading-[1.05] font-semibold tracking-[-0.035em] sm:text-5xl lg:text-6xl">Subscriptions, without borders.</h1>
        <p className="mt-5 max-w-[46ch] text-base leading-relaxed text-muted-foreground sm:text-lg">
          Accept recurring MUSD payments on Mezo. Create a subscription, share one link, and manage your subscribers with transparent on-chain billing.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link href="/merchant">Create a subscription</Link>
          </Button>
          <Button asChild size="lg" variant="outline">
            <a href="#how-it-works">How it works</a>
          </Button>
        </div>
      </Reveal>
      <Reveal delay={0.1} className="flex justify-center lg:justify-end">
        <CheckoutPreview />
      </Reveal>
    </section>
  );
}
