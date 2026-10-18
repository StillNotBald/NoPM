import { Skeleton } from "@/components/ui/skeleton";

/** Handover loading skeleton: header, four tiles, a few project cards. */
export default function HandoverLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <Skeleton variant="text" width="w-28" height="h-7" />
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} variant="text" width="w-full" height="h-16" />
          ))}
        </div>
        <Skeleton variant="text" width="w-full" height="h-32" />
        <Skeleton variant="text" width="w-full" height="h-32" />
      </div>
    </div>
  );
}
