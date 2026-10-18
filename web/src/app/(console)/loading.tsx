import { PageContainer } from "@/components/ui/page-container";
import { CardSkeleton, LoadingStatus, Skeleton } from "@/components/ui/skeleton";

/**
 * Fallback for any console route that has no loading.tsx of its own (a route's
 * own file always wins). Generic page shape: heading, one card. Announces
 * itself so the wait is not silent to screen readers.
 */
export default function ConsoleLoading() {
  return (
    <PageContainer className="space-y-6">
      <LoadingStatus />
      <Skeleton variant="text" width="w-40" height="h-7" />
      <CardSkeleton lines={5} />
    </PageContainer>
  );
}
