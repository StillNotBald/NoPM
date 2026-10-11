import { redirect } from "next/navigation";
import { Suspense } from "react";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewRiskButton } from "@/components/registers/new-risk-form";
import { RiskHeatmap } from "@/components/registers/risk-heatmap";
import { RiskDataList } from "@/components/registers/risk-detail";
import { RiskFocusOpener } from "@/components/registers/risk-focus-opener";
import { EmptyState } from "@/components/ui/empty-state";

export default async function RisksPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  const [{ data: risks }, { data: projects }, { data: members }, { data: viewerProfile }] = await Promise.all([
    db
      .from("risks")
      .select(
        "id, reference_id, title, description, project_id, severity, likelihood, status, owner_id, due_date, probability_pct, impact_score, response_strategy, risk_category, impact_area, trigger, residual_risk, category, mitigation, raised_at",
      )
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
    // owner_id → display name. risks.owner_id references profiles(id); also
    // map resource_members so a member id resolves regardless of source.
    db.from("profiles").select("id, display_name, email"),
    // caller's own role — mirrors requireScope() in lib/auth/guard.ts: only
    // "viewer" is read-only. Read-only lookup, never audited (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  const canWrite = viewerProfile?.role !== "viewer";

  const { data: resourceMembers } = await db
    .from("resource_members")
    .select("id, name");

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  const ownerMap = new Map<string, string>();
  for (const m of members ?? []) {
    ownerMap.set(m.id, m.display_name ?? m.email ?? m.id.slice(0, 8) + "…");
  }
  for (const rm of resourceMembers ?? []) {
    if (!ownerMap.has(rm.id)) ownerMap.set(rm.id, rm.name);
  }

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Risk Register"
        action={<NewRiskButton projects={projects ?? []} />}
      />

      {/* Deep-link auto-opener — opens inspector for ?risk=<id> */}
      <Suspense>
        <RiskFocusOpener
          risks={risks ?? []}
          projectMap={projectMap}
          ownerMap={Object.fromEntries(ownerMap)}
        />
      </Suspense>

      {/* Exposure heatmap — 5×5 probability × impact matrix */}
      {risks && risks.length > 0 && (
        <Card>
          <div className="border-b border-border-subtle px-5 py-3">
            <h2 className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Exposure heatmap
            </h2>
          </div>
          <div className="px-5 py-4">
            <RiskHeatmap risks={risks} />
          </div>
        </Card>
      )}

      {/* List — table ≥md, cards <md (F5) */}
      <Card>
        {risks && risks.length > 0 ? (
          <RiskDataList
            risks={risks}
            projectMap={projectMap}
            ownerMap={Object.fromEntries(ownerMap)}
            dateDisplayPref={dateDisplayPref}
          />
        ) : (
          <EmptyState
            purpose="The risk register tracks anything that could derail a project before it happens — probability, impact, and a mitigation owner."
            canWrite={canWrite}
            action={<NewRiskButton projects={projects ?? []} />}
            docsHref="/trust"
            docsLabel="See governance in the Trust Center"
          />
        )}
      </Card>
      </div>
    </div>
  );
}
