import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Clashes loading skeleton — mirrors Clashes layout:
 * page header · clashes table
 */
export default function ClashesLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-20" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* clashes table: ref, type, projects, severity, status, raised */}
        <TableSkeleton rows={7} cols={6} />
      </div>
    </div>
  );
}
