import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

/** "What changed" loading skeleton: header, filter row, one list card. */
export default function ChangesLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton variant="text" width="w-40" height="h-7" />
        <Skeleton variant="rect" width="w-full" height="h-24" />
        <CardSkeleton lines={8} />
      </div>
    </div>
  );
}
