import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { DecisionTable } from "@/components/decisions/decision-table";
import { NewDecisionButton } from "@/components/decisions/new-decision-button";
import type { Decision } from "@/components/decisions/decision-form";

export default async function DecisionsPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: decisions }, { data: projects }] = await Promise.all([
    db
      .from("decisions")
      .select(
        "id, workspace_id, project_id, reference_id, title, context, options, decision, rationale, status, decided_by, decided_by_label, decided_at, supersedes, created_at, updated_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
  ]);

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  // Build id → reference_id map for supersedes display
  const decisionList = (decisions ?? []) as Decision[];
  const refMap: Record<string, string> = {};
  for (const d of decisionList) {
    if (d.id && d.reference_id) refMap[d.id] = d.reference_id;
  }

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title="Decision Log"
          action={<NewDecisionButton projects={projects ?? []} />}
        />

        <Card>
          <DecisionTable
            rows={decisionList}
            projectMap={projectMap}
            refMap={refMap}
            projects={projects ?? []}
          />
        </Card>
      </div>
    </div>
  );
}
