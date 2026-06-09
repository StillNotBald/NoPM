import { CardSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Risks loading skeleton — mirrors Risk Register layout:
 * page header · exposure heatmap card · risk table
 */
export default function RisksLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-32" height="h-7" />
          <Skeleton variant="rect" width="w-24" height="h-9" />
        </div>

        {/* exposure heatmap card */}
        <CardSkeleton lines={5} />

        {/* risk register table: ref, title, project, severity, score, strategy, status, owner, due */}
        <TableSkeleton rows={7} cols={9} />
      </div>
    </div>
  );
}
