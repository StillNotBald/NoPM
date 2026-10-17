import { StatGridSkeleton, CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Portfolio loading skeleton: header, summary strip, program cards. */
export default function PortfolioLoading() {
  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-44" height="h-7" />
        <Skeleton variant="rect" width="w-32" height="h-9" />
      </div>
      <StatGridSkeleton count={5} />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={4} />
    </PageContainer>
  );
}
