import { Musd } from "@/components/shared/money";
import { StatusBadge } from "@/components/shared/status-badge";
import { SUBSCRIPTION_STATE } from "@/lib/client/status";

const ONE = 10n ** 18n;

/** Hero visual: the real checkout summary building blocks with static example values. */
export function CheckoutPreview() {
  const rows: [string, React.ReactNode][] = [
    ["Price", <span key="p"><Musd value={12n * ONE} /> <span className="text-muted-foreground">per month</span></span>],
    ["First payment", <span key="f" className="num">Today</span>],
    ["Spending limit", <span key="c"><Musd value={144n * ONE} /> <span className="text-muted-foreground">(12 months)</span></span>],
    ["Cancel", <span key="x">Anytime, from your account</span>],
  ];
  return (
    <figure className="relative w-full max-w-md rounded-xl border bg-card shadow-panel" aria-label="Preview of a MezoSub checkout with example values">
      <div className="flex items-center justify-between border-b px-5 py-3">
        <span className="text-[0.8125rem] text-muted-foreground">Preview, example values</span>
        <StatusBadge meta={SUBSCRIPTION_STATE.active} />
      </div>
      <div className="px-5 pt-5">
        <p className="text-sm text-muted-foreground">Northwind Studio</p>
        <p className="mt-0.5 text-lg font-semibold tracking-[-0.01em]">Design library, Pro</p>
      </div>
      <dl className="mt-4 space-y-3 px-5 pb-5 text-sm">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-4">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right">{v}</dd>
          </div>
        ))}
      </dl>
      <figcaption className="border-t bg-surface px-5 py-3 text-[0.8125rem] text-muted-foreground rounded-b-xl">
        You&apos;re allowing MezoSub to charge up to 144 MUSD in total, 12 per month, to Northwind Studio. Nothing else.
      </figcaption>
    </figure>
  );
}
