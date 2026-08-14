import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { ChangeTable } from "@/components/change-control/change-table";
import { NewChangeButton } from "@/components/change-control/new-change-button";
import { ChangeFocusOpener } from "@/app/(console)/change-control/_change-focus-opener";
import type { ChangeRequest } from "@/components/change-control/change-form";

export default async function ChangeControlPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: changeRequests }, { data: projects }, { data: viewerProfile }] = await Promise.all([
    db
      .from("change_requests")
      .select(
        "id, workspace_id, project_id, reference_id, title, description, category, priority, status, impact_summary, impact_schedule_days, impact_cost, requested_by, requested_by_label, decided_by, decided_by_label, decision_rationale, raised_at, decided_at, target_date, created_at, updated_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
    // caller's own role — see risks/page.tsx for the pattern (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const canWrite = viewerProfile?.role !== "viewer";

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  // Summary counts
  const changeRequestRows = (changeRequests ?? []) as ChangeRequest[];
  const reviewCount = changeRequestRows.filter(
    (cr) => cr.status === "raised" || cr.status === "under_review",
  ).length;

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title="Change Control"
          action={<NewChangeButton projects={projects ?? []} />}
        />

        {/* Deep-link auto-open: ?cr=<id> opens the matching change request in the inspector */}
        <Suspense fallback={null}>
          <ChangeFocusOpener
            changeRequests={changeRequestRows}
            projectMap={projectMap}
            projects={projects ?? []}
          />
        </Suspense>

        {/* Review queue callout */}
        {reviewCount > 0 && (
          <div className="rounded-lg border border-warning/40 bg-warning/8 px-4 py-3 flex items-center gap-3">
            <span className="inline-block h-2 w-2 rounded-full bg-warning shrink-0" />
            <p className="text-sm text-ink-secondary">
              <span className="font-medium text-ink">{reviewCount}</span>{" "}
              {reviewCount === 1 ? "change request requires" : "change requests require"} a
              decision.
            </p>
          </div>
        )}

        {/* Table */}
        <Card>
          <ChangeTable
            rows={changeRequestRows}
            projectMap={projectMap}
            projects={projects ?? []}
            canWrite={canWrite}
          />
        </Card>
      </div>
    </div>
  );
}
