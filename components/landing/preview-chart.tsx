"use client";

import { Area, AreaChart, ResponsiveContainer, XAxis, YAxis } from "recharts";

// Static illustrative series for the landing preview only.
const DATA = [18, 24, 22, 31, 29, 36, 41, 39, 47, 52, 49, 58, 63, 61].map((v, i) => ({ d: i + 1, v }));

export function PreviewChart() {
  return (
    <div className="h-40 w-full" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={DATA} margin={{ top: 8, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="previewFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.22} />
              <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="d" hide />
          <YAxis hide domain={[0, "dataMax + 10"]} />
          <Area type="monotone" dataKey="v" stroke="var(--chart-1)" strokeWidth={2} fill="url(#previewFill)" isAnimationActive={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
