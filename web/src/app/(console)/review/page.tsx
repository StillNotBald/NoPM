import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueueCallout } from "@/components/ui/queue-callout";
import { QueryError } from "@/components/ui/query-error";
import { QueueList } from "@/components/review/queue-list";
import { gatherReviewItems, type ReviewItem } from "@/lib/review/gather";

export const metadata = { title: "Review" };

export default async function ReviewQueuePage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();

  if (!user) redirect("/login");

  // The viewer's own role (profiles RLS lets a person read their own row): the
  // queue works out per item whether THIS person may decide it.
  const { data: viewerProfile } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  const viewer = { id: user.id, role: (viewerProfile?.role as string | null | undefined) ?? null };

  let items: ReviewItem[];
  try {
    items = await gatherReviewItems(db, viewer);
  } catch (e) {
    return <QueryError what="the review queue" message={e instanceof Error ? e.message : null} />;
  }

  const oldest = items.reduce((m, i) => Math.max(m, i.ageDays), 0);

  return (
    <PageContainer width="narrow" className="space-y-6">
      <PageHeader title="Review Queue" />

      <QueueCallout count={items.length} noun="item" href="#queue" actionLabel="Jump to queue" className="mb-3">
        Oldest waiting {oldest === 0 ? "today" : `${oldest} day${oldest === 1 ? "" : "s"}`}
      </QueueCallout>

      {/* Intro line — one sentence explaining purpose */}
      <p className="text-sm text-ink-muted">
        Every decision waiting for a human — approvals, rebaselines, risks,
        clashes, and documents in review — in one place, priority-sorted.
      </p>

      <div id="queue">
        <QueueList items={items} />
      </div>
    </PageContainer>
  );
}
