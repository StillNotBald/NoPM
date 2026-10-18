import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Integrations loading skeleton: header, Lark card, account card, calendar card. */
export default function IntegrationsLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <Skeleton variant="text" width="w-32" height="h-7" />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={2} />
      <CardSkeleton lines={3} />
    </PageContainer>
  );
}
