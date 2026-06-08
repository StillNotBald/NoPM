import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { QueueList } from "@/components/review/queue-list";
import { gatherReviewItems } from "@/lib/review/gather";

export const metadata = { title: "Review Queue — NoPM" };

// ── Count chips shown in the page header ──────────────────────────────────────

function TotalChip({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span className="rounded-full bg-danger/10 px-2.5 py-0.5 font-mono text-xs font-medium text-danger">
      {count} pending
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function ReviewQueuePage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");

  const items = await gatherReviewItems(db);

  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader
        title="Review Queue"
        action={<TotalChip count={items.length} />}
      />

      {/* Intro line — one sentence explaining purpose */}
      <p className="text-sm text-ink-muted -mt-3">
        Every decision waiting for a human — approvals, rebaselines, risks,
        clashes, and documents in review — in one place, priority-sorted.
      </p>

      <QueueList items={items} />
    </div>
  );
}
