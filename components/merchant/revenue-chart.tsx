"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatUnits } from "viem";
import { musd } from "@/lib/client/format";

interface Point {
  date: string;
  amount: string;
}

function label(date: string) {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Daily revenue, last 30 days. Values converted to numbers for drawing only; labels use exact wei formatting. */
export function RevenueChart({ series }: { series: Point[] }) {
  const data = series.map((p) => {
    let wei = 0n;
    try {
      wei = BigInt(p.amount);
    } catch {
      /* treat invalid as zero */
    }
    return { date: p.date, label: label(p.date), value: Number(formatUnits(wei, 18)), wei: wei.toString() };
  });
  const empty = data.every((d) => d.value === 0);

  if (!data.length || empty) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-center">
        <p className="text-sm font-medium">No revenue in the last 30 days</p>
        <p className="text-[0.8125rem] text-muted-foreground">Collected payments show up here day by day.</p>
      </div>
    );
  }

  const total = data.reduce((a, d) => a + BigInt(d.wei), 0n);
  return (
    <figure className="h-56 w-full" aria-label={`Revenue over the last 30 days: ${musd(total)} MUSD in total`}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--chart-grid)" />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            minTickGap={24}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
          />
          <YAxis
            width={48}
            tickLine={false}
            axisLine={false}
            tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
            tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(Math.round(v * 100) / 100))}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)" }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !p) return null;
              return (
                <div className="rounded-md border bg-popover px-3 py-2 text-[0.8125rem] shadow-panel">
                  <p className="text-muted-foreground">{p.label}</p>
                  <p className="num font-medium">{musd(p.wei)} MUSD</p>
                </div>
              );
            }}
          />
          <Area type="monotone" dataKey="value" stroke="var(--chart-1)" strokeWidth={2} fill="url(#rev-fill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </figure>
  );
}
