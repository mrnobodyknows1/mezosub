import { Reveal } from "./reveal";

const STEPS = [
  { title: "Create a plan", body: "Set a price in MUSD, how often it bills, and an optional trial or intro price. Publishing it is one transaction." },
  { title: "Share the checkout link", body: "Subscribers open your link, see the exact terms, and approve a spending limit from their own wallet." },
  { title: "Get paid as payments come due", body: "When a payment is due, you or MezoSub's keeper triggers the collection. MUSD moves straight to your payout wallet." },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-20 border-t bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
        <Reveal>
          <h2 className="max-w-[22ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">Three steps from plan to payout.</h2>
        </Reveal>
        <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((s, i) => (
            <li key={s.title}>
              <Reveal delay={i * 0.06} className="border-t-2 border-foreground pt-5">
                <span className="num text-sm text-muted-foreground">{i + 1}</span>
                <h3 className="mt-2 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 max-w-[38ch] text-sm leading-relaxed text-muted-foreground">{s.body}</p>
              </Reveal>
            </li>
          ))}
        </ol>
        <p className="mt-12 max-w-[65ch] text-sm text-muted-foreground">
          Nothing runs by itself on-chain. Each payment is collected by the merchant or by MezoSub&apos;s keeper once it is due, and the contract checks every rule before any MUSD moves.
        </p>
      </div>
    </section>
  );
}
