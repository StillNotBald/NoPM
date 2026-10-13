import { PageContainer } from "@/components/ui/page-container";
import { CardSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Risks loading skeleton — mirrors Risk Register layout:
 * page header · exposure heatmap card · risk table
 */
export default function RisksLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="space-y-6">
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
    </PageContainer>
  );
}
