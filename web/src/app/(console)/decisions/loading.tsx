import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Decisions loading skeleton — mirrors Decision Log layout:
 * page header · decisions table
 */
export default function DecisionsLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-32" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* decisions table: ref, title, project, status, decided by, date */}
        <TableSkeleton rows={7} cols={6} />
      </div>
    </div>
  );
}
