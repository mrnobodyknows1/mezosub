import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Reveal } from "./reveal";

export function ClosingCta() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <Reveal className="flex flex-col items-start gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="max-w-[20ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">Your first plan takes a few minutes.</h2>
          <p className="mt-3 max-w-[50ch] text-muted-foreground">Connect a wallet, set a price, and share the link.</p>
        </div>
        <Button asChild size="lg">
          <Link href="/merchant">Create a subscription</Link>
        </Button>
      </Reveal>
    </section>
  );
}
