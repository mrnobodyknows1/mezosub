import type { StatusMeta } from "@/lib/client/status";
import { TONE_CLASS } from "@/lib/client/status";
import { cn } from "@/lib/client/utils";

/** Status word with a tone colour. Text carries the meaning; colour only reinforces it. */
export function StatusBadge({ meta, className }: { meta: StatusMeta; className?: string }) {
  const t = TONE_CLASS[meta.tone];
  return (
    <span
      title={meta.hint || undefined}
      data-tone={meta.tone}
      className={cn("inline-flex items-center gap-1.5 text-[0.8125rem] font-medium whitespace-nowrap", t.text, className)}
    >
      <span aria-hidden className={cn("size-1.5 rounded-full", t.dot)} />
      {meta.label}
    </span>
  );
}
