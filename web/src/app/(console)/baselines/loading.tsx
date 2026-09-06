import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Baselines loading skeleton — mirrors Baselines layout:
 * page header · locked baselines table · rebaselines table
 */
export default function BaselinesLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
        </div>

        {/* locked baselines: project, locked at, locked by, reason */}
        <TableSkeleton rows={4} cols={4} />

        {/* rebaselines: project, status, requested, sign-offs */}
        <TableSkeleton rows={4} cols={4} />
      </div>
    </div>
  );
}
