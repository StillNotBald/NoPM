import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Documents loading skeleton — mirrors Documents layout:
 * page header · document list table
 */
export default function DocumentsLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>

        {/* documents table: ref, title, project, type, version, status, author, date */}
        <TableSkeleton rows={8} cols={8} />
      </div>
    </div>
  );
}
