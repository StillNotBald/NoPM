import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Sprints loading skeleton: header, sprint cards. */
export default function SprintsLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-24" height="h-7" />
      </div>
      <CardSkeleton lines={4} />
      <CardSkeleton lines={4} />
    </PageContainer>
  );
}
