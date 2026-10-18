import { CardSkeleton, LoadingStatus, Skeleton } from "@/components/ui/skeleton";

/**
 * Project detail loading skeleton: header (code chip, title, badges), completion
 * bar, tab strip, then the Overview cards. Without it, navigating from the list
 * showed the LIST skeleton (projects/loading.tsx), a table where a project page
 * was about to appear.
 */
export default function ProjectDetailLoading() {
  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <LoadingStatus label="project" />

      <div className="space-y-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <Skeleton variant="rect" width="w-14" height="h-6" />
            <div className="space-y-2">
              <Skeleton variant="text" width="w-64" height="h-7" />
              <Skeleton variant="text" width="w-32" height="h-4" />
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Skeleton variant="rect" width="w-20" height="h-6" />
            <Skeleton variant="rect" width="w-16" height="h-8" />
          </div>
        </div>
        <Skeleton variant="rect" width="w-full sm:w-80" height="h-2" />
      </div>

      <Skeleton variant="rect" width="w-full" height="h-11" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
        <CardSkeleton lines={3} />
      </div>
    </div>
  );
}
