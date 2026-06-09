import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Change Control loading skeleton — mirrors Change Control layout:
 * page header · change requests table
 */
export default function ChangeControlLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-36" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* change requests table: ref, title, project, impact, priority, status, requested by, date */}
        <TableSkeleton rows={7} cols={8} />
      </div>
    </div>
  );
}
