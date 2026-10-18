import { CardSkeleton, TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/** Trust Center loading skeleton: header, filter bar, stream + sidebar. */
export default function TrustLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-36" height="h-7" />
          <Skeleton variant="rect" width="w-28" height="h-9" />
        </div>
        <Skeleton variant="rect" height="h-16" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_260px]">
          <TableSkeleton rows={8} cols={4} />
          <CardSkeleton lines={6} />
        </div>
      </div>
    </div>
  );
}
