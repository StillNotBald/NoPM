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
import { AuditPackPanel } from "@/components/export/audit-pack-panel";
import { ChangeTable } from "@/components/change-control/change-table";
import { NewChangeButton } from "@/components/change-control/new-change-button";
import { ChangeFocusOpener } from "@/app/(console)/change-control/_change-focus-opener";
import type { ChangeRequest } from "@/components/change-control/change-form";
import { isRetroOverdue } from "@/lib/governance/tiers";
import { judgeDecision, canEditChangeRequest, canReopenChangeRequest, canDecideByRole } from "@/lib/review/four-eyes";

export const metadata = { title: "Change Control" };

const STATUS_FILTERS = ["raised", "under_review", "approved", "implemented", "rejected", "deferred", "all"] as const;
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

  const [crRes, projRes, { data: viewerProfile }, decisionLinksRes] = await Promise.all([
    db
      .from("change_requests")
      .select(
        // + the requester columns: read here only to work out who may decide
        // (judgeDecision); they are dropped before the rows reach the browser.
        "id, workspace_id, project_id, reference_id, title, description, category, priority, status, impact_summary, impact_schedule_days, impact_cost, impact_scope, implemented_at, implemented_by_label, implemented_note, tier, approval_deadline_at, is_emergency, retro_due_at, retro_decided_at, retro_outcome, requested_by, requested_by_type, requested_by_id, requested_principal_id, requested_by_label, decided_by, decided_by_label, decision_rationale, raised_at, decided_at, target_date, created_at, updated_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
    // caller's own role — see risks/page.tsx for the pattern (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
    // B1: decisions linked to a change request (shown as "Decisions: n" in its detail).
    db
      .from("decisions")
      .select("id, reference_id, title, change_request_id")
      .not("change_request_id", "is", null)
      .order("created_at", { ascending: true }),
  ]);
  const { data: changeRequests, error: crError } = crRes;
  const { data: projects } = projRes;
  if (crError) return <QueryError what="change requests" message={crError.message} />;
  const canWrite = viewerProfile?.role !== "viewer";
  // Audit pack: admin or manager only (GET /api/export enforces the same rule).
  const canAuditPack = viewerProfile?.role === "admin" || viewerProfile?.role === "manager";

  // A failed link lookup only hides the decisions list; it never blocks the page.
  const decisionsByCr = new Map<string, Array<{ id: string; reference_id: string | null; title: string }>>();
  for (const d of (decisionLinksRes.data ?? []) as Array<{ id: string; reference_id: string | null; title: string; change_request_id: string }>) {
    const list = decisionsByCr.get(d.change_request_id) ?? [];
    list.push({ id: d.id, reference_id: d.reference_id, title: d.title });
    decisionsByCr.set(d.change_request_id, list);
  }

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  const viewer = { id: user.id, role: (viewerProfile?.role as string | null | undefined) ?? null };
  type RawRow = ChangeRequest & {
    requested_by_type?: string | null;
    requested_by_id?: string | null;
    requested_principal_id?: string | null;
  };
  // Four-eyes, decided the way the API decides (by person; a token counts as its
  // creator). Attached to each row so the inspector shows the note, not buttons
  // that would be refused. Requester columns are not forwarded to the client.
  // D7: with fewer than two admins a manager may decide an admin-level request.
  const { count: adminCount } = await db.from("profiles").select("id", { count: "exact", head: true }).eq("role", "admin");
  const singleAdmin = (adminCount ?? 2) < 2;
  const allRows: ChangeRequest[] = ((changeRequests ?? []) as RawRow[]).map((raw) => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { requested_by_type, requested_by_id, requested_principal_id, ...row } = raw;
    // G4: an emergency change is open until its retro decision, even after it went live.
    const open =
      row.status === "raised" ||
      row.status === "under_review" ||
      row.status === "emergency" ||
      (row.status === "implemented" && row.is_emergency === true && !row.retro_decided_at);
    const canEdit = canEditChangeRequest({
      viewerId: user.id,
      status: row.status,
      requestedPrincipalId: requested_principal_id,
    });
    const canReopen = canReopenChangeRequest({
      viewerId: user.id,
      viewerRole: viewer.role,
      status: row.status,
      requestedPrincipalId: requested_principal_id,
    });
    const canStartReview = row.status === "raised" && canDecideByRole(viewer.role);
    // M2: the requester, or a manager or admin, marks an approved request implemented.
    const canImplement =
      (row.status === "approved" || row.status === "emergency") &&
      (canDecideByRole(viewer.role) || (!!requested_principal_id && requested_principal_id === user.id));
    const decisions = decisionsByCr.get(row.id);
    const extra = decisions ? { decisions } : {};
    return open
      ? { ...row, ...extra, retro_overdue: isRetroOverdue(row, new Date()), canEdit, canStartReview, canImplement, decide: judgeDecision({ viewer, kind: "change_request", row: raw, singleAdmin }) }
      : { ...row, ...extra, canEdit, canReopen, canImplement };
  });
  const projectId =
    rawProject && (projects ?? []).some((p) => p.id === rawProject) ? rawProject : "";
  const scoped = projectId ? allRows.filter((cr) => cr.project_id === projectId) : allRows;
  const changeRequestRows = status === "all" ? scoped : scoped.filter((cr) => cr.status === status);
  const count = (s: string) => scoped.filter((cr) => cr.status === s).length;
  // Only requests this person is allowed to decide are waiting on them.
  const awaitingMe = allRows.filter((cr) => cr.decide?.canDecide).length;

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

      {canAuditPack && <AuditPackPanel />}

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
                { value: "implemented", label: "Implemented", count: count("implemented") },
                { value: "rejected", label: "Rejected", count: count("rejected") },
                { value: "deferred", label: "Deferred", count: count("deferred") },
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
