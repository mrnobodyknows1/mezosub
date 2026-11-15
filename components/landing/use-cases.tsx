import { Reveal } from "./reveal";

export function UseCases() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
      <Reveal>
        <h2 className="max-w-[20ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">Made for anything that renews.</h2>
      </Reveal>
      <div className="mt-12 grid gap-10 lg:grid-cols-[1.3fr_1fr] lg:gap-16">
        <Reveal className="rounded-xl border bg-brand-soft p-8 sm:p-10">
          <h3 className="text-2xl font-semibold tracking-[-0.02em]">SaaS and software</h3>
          <p className="mt-3 max-w-[48ch] leading-relaxed text-muted-foreground">
            Monthly or yearly plans, free trials and intro pricing. Webhooks tell your app when a payment lands or fails, so access stays in sync.
          </p>
        </Reveal>
        <div className="flex flex-col justify-center divide-y">
          <Reveal delay={0.05} className="pb-8">
            <h3 className="text-lg font-semibold">Creators</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Memberships for newsletters, courses and private content. Fans pay from their wallet, wherever they are.</p>
          </Reveal>
          <Reveal delay={0.1} className="pt-8">
            <h3 className="text-lg font-semibold">Communities and clubs</h3>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Recurring dues with a clear record of who paid and when. No spreadsheet chasing.</p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
