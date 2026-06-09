import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Projects loading skeleton — mirrors project list layout:
 * page header · project table
 */
export default function ProjectsLoading() {
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      {/* page header */}
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-24" height="h-7" />
        <Skeleton variant="rect" width="w-28" height="h-9" />
      </div>

      {/* projects table */}
      <TableSkeleton rows={8} cols={6} />
    </div>
  );
}
