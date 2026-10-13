import { redirect } from "next/navigation";
import { Suspense } from "react";
import { cookies } from "next/headers";
import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { APPEARANCE_COOKIE_NAME, parseAppearancePrefs } from "@/lib/theme/appearance";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { ExportCsvButton } from "@/components/export-csv-button";
import { NewRiskButton } from "@/components/registers/new-risk-form";
import { RiskHeatmap } from "@/components/registers/risk-heatmap";
import { RiskRegister } from "@/components/registers/risk-register";
import { RiskFocusOpener } from "@/components/registers/risk-focus-opener";
import { parseRiskPageParams, riskExportHref } from "./_params";

export const metadata: Metadata = { title: "Risks" };

export default async function RisksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = parseRiskPageParams(await searchParams);
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const dateDisplayPref = parseAppearancePrefs(
    (await cookies()).get(APPEARANCE_COOKIE_NAME)?.value,
  ).dateDisplay;

  // Same whitelisted filters/sort the toolbar writes to the URL (see ./_params).
  let riskQuery = db
    .from("risks")
    .select(
      "id, reference_id, title, description, project_id, severity, likelihood, status, owner_id, due_date, probability_pct, impact_score, response_strategy, risk_category, impact_area, trigger, residual_risk, category, mitigation, raised_at",
    );
  if (params.status) riskQuery = riskQuery.eq("status", params.status);
  if (params.severity) riskQuery = riskQuery.eq("severity", params.severity);
  if (params.project_id) riskQuery = riskQuery.eq("project_id", params.project_id);
  if (params.q) {
    // strip PostgREST filter metacharacters and LIKE wildcards from user input
    const term = params.q.replace(/[%_,()\*]/g, " ").trim();
    if (term) riskQuery = riskQuery.ilike("title", `%${term}%`);
  }
  riskQuery = params.sort
    ? riskQuery.order(params.sort.field, { ascending: params.sort.ascending, nullsFirst: false })
    : riskQuery.order("created_at", { ascending: false });

  const [
    { data: risks, error: risksError },
    { data: projects },
    { data: members },
    { data: viewerProfile },
  ] = await Promise.all([
    riskQuery,
    db.from("projects").select("id, name").order("name"),
    // owner_id -> display name. risks.owner_id references profiles(id); also
    // map resource_members so a member id resolves regardless of source.
    db.from("profiles").select("id, display_name, email"),
    // caller's own role - mirrors requireScope() in lib/auth/guard.ts: only
    // "viewer" is read-only. Read-only lookup, never audited (L-46).
    db.from("profiles").select("role").eq("id", user.id).maybeSingle(),
  ]);
  if (risksError) return <QueryError what="risks" message={risksError.message} />;
  const canWrite = viewerProfile?.role !== "viewer";

  const { data: resourceMembers } = await db.from("resource_members").select("id, name");

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  const ownerMap = new Map<string, string>();
  for (const m of members ?? []) {
    ownerMap.set(m.id, m.display_name ?? m.email ?? m.id.slice(0, 8) + "...");
  }
  for (const rm of resourceMembers ?? []) {
    if (!ownerMap.has(rm.id)) ownerMap.set(rm.id, rm.name);
  }
  const ownerRecord = Object.fromEntries(ownerMap);
  const rows = risks ?? [];

  return (
    <PageContainer className="space-y-6">
      <PageHeader
        title="Risk Register"
        exports={<ExportCsvButton href={riskExportHref(params)} />}
        action={<NewRiskButton projects={projects ?? []} />}
      />

      {/* Deep-link auto-opener: opens inspector for ?risk=<id> */}
      <Suspense>
        <RiskFocusOpener risks={rows} projectMap={projectMap} ownerMap={ownerRecord} />
      </Suspense>

      {/* Exposure heatmap: 5x5 probability x impact matrix (the key insight) */}
      {rows.length > 0 && (
        <section aria-labelledby="exposure-heatmap-heading">
          <Card>
            <div className="border-b border-border-subtle px-5 py-3">
              <h2 id="exposure-heatmap-heading" className="text-base font-semibold tracking-tight text-ink">
                Exposure heatmap
              </h2>
              <p className="mt-0.5 text-xs text-ink-secondary">
                Where the {rows.length} risk{rows.length === 1 ? "" : "s"} in view sit on probability and impact.
              </p>
            </div>
            <div className="px-5 py-4">
              <RiskHeatmap risks={rows} />
            </div>
          </Card>
        </section>
      )}

      {/* Register: toolbar writes URL state; this page re-renders filtered/sorted */}
      <section aria-label="Risk register">
        <Suspense>
          <RiskRegister
            risks={rows}
            projects={projects ?? []}
            projectMap={projectMap}
            ownerMap={ownerRecord}
            dateDisplayPref={dateDisplayPref}
            canWrite={canWrite}
            emptyAction={<NewRiskButton projects={projects ?? []} />}
          />
        </Suspense>
      </section>
    </PageContainer>
  );
}
