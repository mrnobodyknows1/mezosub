import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="mx-auto grid w-full max-w-6xl gap-10 px-4 py-14 sm:px-6 lg:grid-cols-[1.15fr_1fr]">
      <div className="space-y-4">
        <Skeleton className="h-12 w-72" />
        <Skeleton className="h-10 w-48" />
        <Skeleton className="h-56 w-full rounded-xl" />
      </div>
      <Skeleton className="h-72 w-full rounded-xl" />
    </div>
  );
}
