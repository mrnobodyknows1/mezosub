import { Reveal } from "./reveal";

const TERMS = [
  { k: "Amount per period", v: "The plan price, fixed when you subscribe. Later price changes only apply to new subscribers." },
  { k: "Total spending limit", v: "A cap on everything this subscription can ever take. Once it's used up, charges stop until you renew." },
  { k: "Optional end date", v: "Pick a date after which no more payments can be taken." },
  { k: "Cancel anytime", v: "One transaction from your account page. Past payments aren't reversed automatically." },
];

export function Authorization() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-12 px-4 py-20 sm:px-6 md:py-24 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
      <Reveal>
        <h2 className="max-w-[18ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">Subscribers stay in control.</h2>
        <p className="mt-4 max-w-[48ch] leading-relaxed text-muted-foreground">
          Payments go straight from the subscriber&apos;s wallet to the merchant. The contract never holds funds, and it can only take what the subscriber approved.
        </p>
      </Reveal>
      <dl className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2">
        {TERMS.map((t, i) => (
          <Reveal key={t.k} delay={i * 0.05} className="bg-card p-6">
            <dt className="font-semibold">{t.k}</dt>
            <dd className="mt-2 text-sm leading-relaxed text-muted-foreground">{t.v}</dd>
          </Reveal>
        ))}
      </dl>
    </section>
  );
}
