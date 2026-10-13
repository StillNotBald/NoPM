import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueueCallout } from "@/components/ui/queue-callout";
import { QueryError } from "@/components/ui/query-error";
import { UrlFilter } from "@/app/(console)/review/_url-filter";
import { DecisionTable } from "@/components/decisions/decision-table";
import { NewDecisionButton } from "@/components/decisions/new-decision-button";
import { DecisionFocusOpener } from "@/app/(console)/decisions/_decision-focus-opener";
import type { Decision } from "@/components/decisions/decision-form";

export const metadata = { title: "Decision Log — NoPM" };

const STATUSES = ["proposed", "accepted", "superseded", "rejected"] as const;

export default async function DecisionsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status: statusParam } = await searchParams;
  const view = (STATUSES as readonly string[]).includes(statusParam ?? "") ? (statusParam as string) : "all";

  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: decisions, error: decisionsError }, { data: projects }, { data: viewerProfile }] = await Promise.all([
    db
      .from("decisions")
      .select(
        "id, workspace_id, project_id, reference_id, title, context, options, decision, rationale, status, decided_by, decided_by_label, decided_at, supersedes, created_at, updated_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
    // caller's own role — see risks/page.tsx for the pattern (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  if (decisionsError) return <QueryError what="decisions" message={decisionsError.message} />;
  const canWrite = viewerProfile?.role !== "viewer";

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  // Build id → reference_id map for supersedes display
  const decisionList = (decisions ?? []) as Decision[];
  const refMap: Record<string, string> = {};
  for (const d of decisionList) {
    if (d.id && d.reference_id) refMap[d.id] = d.reference_id;
  }

  const proposed = decisionList.filter((d) => d.status === "proposed");
  const oldestDays = proposed.reduce(
    (m, d) => Math.max(m, Math.floor((Date.now() - new Date(d.created_at).getTime()) / 86_400_000)),
    0,
  );
  const visible = view === "all" ? decisionList : decisionList.filter((d) => d.status === view);
  const countOf = (s: string) => decisionList.filter((d) => d.status === s).length;

  return (
    <PageContainer width="narrow" className="space-y-6">
        <PageHeader
          title="Decision Log"
          action={<NewDecisionButton projects={projects ?? []} />}
        />

        {canWrite && (
          <QueueCallout count={proposed.length} noun="proposed decision" href="/decisions?status=proposed" actionLabel="Show proposed" className="mb-0">
            Oldest waiting {oldestDays === 0 ? "today" : `${oldestDays} day${oldestDays === 1 ? "" : "s"}`}
          </QueueCallout>
        )}

        <UrlFilter
          label="Decision status"
          value={view}
          defaultValue="all"
          options={[
            { value: "all", label: "All", count: decisionList.length },
            { value: "proposed", label: "Proposed", count: countOf("proposed"), attention: canWrite && proposed.length > 0 },
            { value: "accepted", label: "Accepted", count: countOf("accepted") },
            { value: "superseded", label: "Superseded", count: countOf("superseded") },
            { value: "rejected", label: "Rejected", count: countOf("rejected") },
          ]}
        />

        {/* Deep-link auto-open: ?dec=<id> opens the matching decision in the inspector */}
        <Suspense fallback={null}>
          <DecisionFocusOpener
            decisions={decisionList}
            projectMap={projectMap}
            refMap={refMap}
            projects={projects ?? []}
          />
        </Suspense>

        <Card>
          <DecisionTable
            rows={visible}
            projectMap={projectMap}
            refMap={refMap}
            projects={projects ?? []}
            canWrite={canWrite}
          />
        </Card>
    </PageContainer>
  );
}
