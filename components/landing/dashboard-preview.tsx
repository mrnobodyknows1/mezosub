import { Musd } from "@/components/shared/money";
import { Panel } from "@/components/shared/page-header";
import { Stat } from "@/components/shared/stat";
import { StatusBadge } from "@/components/shared/status-badge";
import { SUBSCRIPTION_STATE } from "@/lib/client/status";
import { PreviewChart } from "./preview-chart";
import { Reveal } from "./reveal";

const ONE = 10n ** 18n;
const ROWS = [
  { who: "0x8f3c…a21e", plan: "Pro monthly", amount: 12n * ONE, state: SUBSCRIPTION_STATE.active },
  { who: "0x41d0…77b2", plan: "Team yearly", amount: 240n * ONE, state: SUBSCRIPTION_STATE.trialing },
  { who: "0xc92a…0f13", plan: "Pro monthly", amount: 12n * ONE, state: SUBSCRIPTION_STATE.due },
];

export function DashboardPreview() {
  return (
    <section className="border-t bg-surface">
      <div className="mx-auto w-full max-w-6xl px-4 py-20 sm:px-6 md:py-24">
        <Reveal>
          <h2 className="max-w-[22ch] text-3xl font-semibold tracking-[-0.025em] sm:text-4xl">One dashboard for every subscriber.</h2>
          <p className="mt-4 max-w-[56ch] leading-relaxed text-muted-foreground">Revenue, upcoming payments, failures and retries, all read from the chain.</p>
        </Reveal>
        <Reveal delay={0.08} className="mt-12">
          <Panel title="Overview" description="Preview with example data" bodyClassName="space-y-8">
            <div className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              <Stat label="Monthly recurring" value={<Musd value={1284n * ONE} />} />
              <Stat label="Active subscribers" value="107" />
              <Stat label="Due in 7 days" value={<Musd value={312n * ONE} />} hint="26 payments" />
              <Stat label="Failed, 30 days" value="3" />
            </div>
            <PreviewChart />
            <ul className="divide-y text-sm">
              {ROWS.map((r) => (
                <li key={r.who} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <span className="font-mono text-[0.8125rem]">{r.who}</span>
                  <span className="text-muted-foreground">{r.plan}</span>
                  <Musd value={r.amount} />
                  <StatusBadge meta={r.state} />
                </li>
              ))}
            </ul>
          </Panel>
        </Reveal>
      </div>
    </section>
  );
}
