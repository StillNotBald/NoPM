import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** API Tokens loading skeleton: header, token list cards. */
export default function TokensLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-28" height="h-7" />
        <Skeleton variant="rect" width="w-32" height="h-9" />
      </div>
      <CardSkeleton lines={3} />
      <CardSkeleton lines={3} />
    </PageContainer>
  );
}
