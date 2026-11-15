import { ExternalLink } from "lucide-react";
import { contracts, explorerAddress, MEZO_TESTNET_ID } from "@/lib/chain/config";
import { Reveal } from "./reveal";

export function Network() {
  const facts: [string, React.ReactNode][] = [
    ["Network", <>Mezo Testnet, chain <span key="c" className="num">{MEZO_TESTNET_ID}</span></>],
    ["Network fees", "Paid in BTC"],
    ["Token", "MUSD, a dollar stablecoin on Mezo"],
    ["Platform fee", <span key="f" className="num">0%</span>],
  ];
  return (
    <section className="border-t">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
        <Reveal>
          <h2 className="max-w-[24ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">Built on Mezo, billed in MUSD.</h2>
          <p className="mt-4 max-w-[56ch] leading-relaxed text-muted-foreground">Prices stay steady in a dollar stablecoin, and every payment is a public transaction you can check on the explorer.</p>
        </Reveal>
        <dl className="mt-12 grid grid-cols-1 gap-x-8 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {facts.map(([k, v]) => (
            <div key={k} className="border-t border-border pt-4">
              <dt className="text-sm text-muted-foreground">{k}</dt>
              <dd className="mt-1 text-lg font-medium">{v}</dd>
            </div>
          ))}
        </dl>
        <a
          href={explorerAddress(contracts.musd)}
          target="_blank"
          rel="noreferrer"
          className="mt-10 inline-flex max-w-full items-center gap-2 rounded-md text-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <span className="text-muted-foreground">MUSD contract</span>
          <span className="truncate font-mono">{contracts.musd}</span>
          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </a>
      </div>
    </section>
  );
}
