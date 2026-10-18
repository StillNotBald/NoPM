import { CardSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Mainline loading skeleton — mirrors the page layout: header + lens
 * switcher, caption line, one large chart-shaped card.
 */
export default function MainlineLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
          <Skeleton variant="rect" width="w-48" height="h-11" />
        </div>
        <Skeleton variant="text" width="w-80" height="h-4" />
        <CardSkeleton lines={8} />
      </div>
    </div>
  );
}
