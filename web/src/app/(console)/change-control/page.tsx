import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueueCallout } from "@/components/ui/queue-callout";
import { QueryError } from "@/components/ui/query-error";
import { UrlFilter } from "@/app/(console)/review/_url-filter";
import { ProjectFilter } from "@/components/change-control/project-filter";
import { ChangeTable } from "@/components/change-control/change-table";
import { NewChangeButton } from "@/components/change-control/new-change-button";
import { ChangeFocusOpener } from "@/app/(console)/change-control/_change-focus-opener";
import type { ChangeRequest } from "@/components/change-control/change-form";

export const metadata = { title: "Change Control" };

const STATUS_FILTERS = ["raised", "under_review", "approved", "rejected", "all"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

export default async function ChangeControlPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const rawStatus = Array.isArray(sp.status) ? sp.status[0] : sp.status;
  const status: StatusFilter = (STATUS_FILTERS as readonly string[]).includes(rawStatus ?? "")
    ? (rawStatus as StatusFilter)
    : "all";
  const rawProject = Array.isArray(sp.project) ? sp.project[0] : sp.project;

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [crRes, projRes, { data: viewerProfile }] = await Promise.all([
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
  const { data: changeRequests, error: crError } = crRes;
  const { data: projects } = projRes;
  if (crError) return <QueryError what="change requests" message={crError.message} />;
  const canWrite = viewerProfile?.role !== "viewer";

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  const allRows = (changeRequests ?? []) as ChangeRequest[];
  const projectId =
    rawProject && (projects ?? []).some((p) => p.id === rawProject) ? rawProject : "";
  const scoped = projectId ? allRows.filter((cr) => cr.project_id === projectId) : allRows;
  const changeRequestRows = status === "all" ? scoped : scoped.filter((cr) => cr.status === status);
  const count = (s: string) => scoped.filter((cr) => cr.status === s).length;
  // Four-eyes: only CRs raised by someone else await THIS user's decision.
  const awaitingMe = allRows.filter(
    (cr) => (cr.status === "raised" || cr.status === "under_review") && cr.requested_by !== user.id,
  ).length;

  return (
    <PageContainer className="space-y-6">
      <PageHeader title="Change Control" action={<NewChangeButton projects={projects ?? []} />} />

      {/* Deep-link auto-open: ?cr=<id> opens the matching change request in the inspector */}
      <Suspense fallback={null}>
        <ChangeFocusOpener
          changeRequests={allRows}
          projectMap={projectMap}
          projects={projects ?? []}
        />
      </Suspense>

      <div>
        {canWrite && (
          <QueueCallout count={awaitingMe} noun="change request" plural="change requests">
            awaiting your decision
          </QueueCallout>
        )}

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Suspense fallback={null}>
            <UrlFilter
              label="Filter by status"
              value={status}
              defaultValue="all"
              options={[
                { value: "raised", label: "Raised", count: count("raised") },
                { value: "under_review", label: "Under review", count: count("under_review") },
                { value: "approved", label: "Approved", count: count("approved") },
                { value: "rejected", label: "Rejected", count: count("rejected") },
                { value: "all", label: "All", count: scoped.length },
              ]}
            />
            <ProjectFilter projects={projects ?? []} value={projectId} />
          </Suspense>
        </div>

        <Card>
          <ChangeTable
            rows={changeRequestRows}
            projectMap={projectMap}
            projects={projects ?? []}
            canWrite={canWrite}
          />
        </Card>
      </div>
    </PageContainer>
  );
}
