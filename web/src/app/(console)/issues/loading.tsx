import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Issues loading skeleton — mirrors Issue Log layout:
 * page header · issues table
 */
export default function IssuesLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-24" height="h-9" />
        </div>

        {/* issue table: ref, title, project, severity, priority, status, owner, due */}
        <TableSkeleton rows={8} cols={8} />
      </div>
    </div>
  );
}
