import { musd, musdExact } from "@/lib/client/format";
import { cn } from "@/lib/client/utils";

/** A MUSD amount: tabular figures, full precision in aria-label/title. */
export function Musd({
  value,
  compact,
  decimals,
  unit = true,
  className,
}: {
  value: bigint | string | null | undefined;
  compact?: boolean;
  decimals?: number;
  unit?: boolean;
  className?: string;
}) {
  const shown = musd(value, { compact, decimals });
  const exact = musdExact(value);
  return (
    <span className={cn("num whitespace-nowrap", className)} title={exact === "--" ? undefined : `${exact} MUSD`}>
      {shown}
      {unit && shown !== "--" ? <span className="ml-1 text-[0.85em] font-normal text-muted-foreground">MUSD</span> : null}
    </span>
  );
}
