import { TableSkeleton, Skeleton } from "@/components/ui/skeleton";

/**
 * Approvals loading skeleton — mirrors Approvals layout:
 * page header · pending approvals table
 */
export default function ApprovalsLoading() {
  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        {/* page header */}
        <div className="flex items-center justify-between gap-3">
          <Skeleton variant="text" width="w-28" height="h-7" />
        </div>

        {/* approvals table: ref, type, description, requested by, date, actions */}
        <TableSkeleton rows={6} cols={6} />
      </div>
    </div>
  );
}
