import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewRiskButton } from "@/components/registers/new-risk-form";
import {
  RiskHeatmap,
  riskScore,
  exposureBand,
  type ExposureBand,
} from "@/components/registers/risk-heatmap";
import { RiskRowButton } from "@/components/registers/risk-detail";
import { EntityLink } from "@/components/ui/entity-link";
import { RiskFocusOpener } from "@/components/registers/risk-focus-opener";

type SeverityLevel = "low" | "medium" | "high" | "critical";
type RiskStatus = "open" | "mitigating" | "closed" | "accepted";
type ResponseStrategy = "avoid" | "transfer" | "mitigate" | "accept";

function statusTone(s: RiskStatus) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  if (s === "open") return "info" as const;
  return "neutral" as const;
}

// Exposure band → the same heat ramp <Severity> uses (low/med/high/critical).
const BAND_TO_SEVERITY: Record<ExposureBand, SeverityLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  critical: "critical",
};

const STRATEGY_LABEL: Record<ResponseStrategy, string> = {
  avoid: "Avoid",
  transfer: "Transfer",
  mitigate: "Mitigate",
  accept: "Accept",
};

function strategyTone(s: ResponseStrategy) {
  if (s === "avoid") return "danger" as const;
  if (s === "transfer") return "info" as const;
  if (s === "mitigate") return "warning" as const;
  return "success" as const; // accept
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export default async function RisksPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: risks }, { data: projects }, { data: members }] = await Promise.all([
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
  ]);

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

  function ownerName(ownerId: string | null) {
    if (!ownerId) return "—";
    return ownerMap.get(ownerId) ?? ownerId.slice(0, 8) + "…";
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

      {/* Table */}
      <Card>
        {risks && risks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Ref
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide max-w-[240px]">
                    Title
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide max-w-[160px]">
                    Project
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Severity
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Score
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Strategy
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Owner
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Due
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {(risks ?? []).map((risk) => {
                  const score = riskScore(risk.probability_pct, risk.impact_score);
                  const band = exposureBand(score);
                  return (
                  <RiskRowButton
                    key={risk.id}
                    risk={risk}
                    projectName={risk.project_id ? (projectMap[risk.project_id] ?? undefined) : undefined}
                    ownerName={ownerName(risk.owner_id)}
                  >
                    <td className="px-5 py-3 whitespace-nowrap">
                      {risk.reference_id ? (
                        <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted whitespace-nowrap">
                          {risk.reference_id}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-ink min-w-0 max-w-[240px]">
                      <span className="block truncate">{risk.title}</span>
                    </td>
                    <td className="px-5 py-3 min-w-0 max-w-[160px]">
                      {risk.project_id ? (
                        <EntityLink kind="project" id={risk.project_id} muted>
                          {projectMap[risk.project_id] ?? "—"}
                        </EntityLink>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <Severity level={risk.severity as SeverityLevel} />
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {score != null && band ? (
                        <span className="inline-flex items-center gap-2">
                          <Severity level={BAND_TO_SEVERITY[band]} />
                          <span className="font-mono text-xs text-ink-muted tabular-nums">
                            {score}/5
                          </span>
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      {risk.response_strategy ? (
                        <Badge size="sm" tone={strategyTone(risk.response_strategy as ResponseStrategy)}>
                          {STRATEGY_LABEL[risk.response_strategy as ResponseStrategy] ??
                            risk.response_strategy}
                        </Badge>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <Badge size="sm" tone={statusTone(risk.status as RiskStatus)}>
                        {risk.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-ink-secondary whitespace-nowrap text-xs">
                      {ownerName(risk.owner_id)}
                    </td>
                    <td className="px-5 py-3 text-ink-secondary tabular-nums whitespace-nowrap text-xs">
                      {formatDate(risk.due_date)}
                    </td>
                  </RiskRowButton>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">No risks recorded yet.</p>
            <p className="mt-1 text-xs text-ink-muted">Use "New Risk" to log the first one.</p>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
