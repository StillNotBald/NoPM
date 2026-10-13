import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";
import { PageContainer } from "@/components/ui/page-container";

/** Timesheets loading skeleton: header, entry cards. */
export default function TimesheetsLoading() {
  return (
    <PageContainer className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <Skeleton variant="text" width="w-32" height="h-7" />
      </div>
      <CardSkeleton lines={5} />
      <CardSkeleton lines={4} />
    </PageContainer>
  );
}
