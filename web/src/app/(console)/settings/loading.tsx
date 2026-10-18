import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Settings loading skeleton: header, profile card, appearance card. */
export default function SettingsLoading() {
  return (
    <PageContainer width="narrow" className="space-y-6">
      <Skeleton variant="text" width="w-40" height="h-7" />
      <CardSkeleton lines={4} />
      <CardSkeleton lines={3} />
    </PageContainer>
  );
}
