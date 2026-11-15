import { cn } from "@/lib/client/utils";

/** MezoSub mark: two stacked arcs forming a loop (a recurring cycle) inside a rounded square. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6", className)}>
      <rect width="32" height="32" rx="8" className="fill-primary" />
      <path d="M9 17.5a7 7 0 0 1 12.2-4.7" fill="none" strokeWidth="2.6" strokeLinecap="round" className="stroke-primary-foreground" />
      <path d="M23 14.5a7 7 0 0 1-12.2 4.7" fill="none" strokeWidth="2.6" strokeLinecap="round" className="stroke-brand" />
      <path d="M21.6 9.4v3.7h-3.7" fill="none" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="stroke-primary-foreground" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-semibold tracking-[-0.02em]", className)}>
      <LogoMark />
      <span>MezoSub</span>
    </span>
  );
}
