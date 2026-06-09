import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { EntityLink } from "@/components/ui/entity-link";
import { ClashFocusOpener } from "@/app/(console)/clashes/_clash-focus-opener";

type ClashType = "schedule" | "resource" | "dependency";
type ClashSeverity = "low" | "medium" | "high" | "critical";
type ClashStatus = "open" | "investigating" | "resolved";

export type ClashRow = {
  id: string;
  reference_id: string | null;
  title: string;
  type: string;
  severity: string;
  status: string;
  description: string | null;
  over_allocation_pct: number | null;
  recommended_action: string | null;
  project_a_id: string | null;
  project_b_id: string | null;
};

function typeTone(t: ClashType) {
  if (t === "resource") return "warning" as const;
  if (t === "dependency") return "danger" as const;
  return "info" as const; // schedule
}

function statusTone(s: ClashStatus) {
  if (s === "resolved") return "success" as const;
  if (s === "investigating") return "info" as const;
  return "warning" as const; // open
}

function typeLabel(t: ClashType) {
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function statusLabel(s: ClashStatus) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function ClashesPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: clashes }, { data: projects }] = await Promise.all([
    db
      .from("clashes")
      .select("id, reference_id, title, type, severity, project_a_id, project_b_id, status, description, over_allocation_pct, recommended_action")
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
  ]);

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));
  const clashList = (clashes ?? []) as ClashRow[];

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Clash Register" />

      {/* Deep-link auto-open: ?clash=<id> opens the matching row detail */}
      <Suspense fallback={null}>
        <ClashFocusOpener clashes={clashList} projectMap={projectMap} />
      </Suspense>

      {/* Legend */}
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Badge tone="neutral" size="sm">auto</Badge>
        <span>= system-detected resource over-allocation</span>
      </div>

      {/* Table */}
      <Card>
        {clashList.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
                    Ref
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Title
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
                    Type
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
                    Severity
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Projects
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide whitespace-nowrap">
                    Status
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Details
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {clashList.map((clash) => {
                  const isAuto = clash.type === "resource";

                  return (
                    <tr
                      key={clash.id}
                      id={`clash-${clash.id}`}
                      className="hover:bg-sunken transition-colors duration-100"
                    >
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        {clash.reference_id ? (
                          <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
                            {clash.reference_id}
                          </span>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 min-w-0 max-w-[200px]">
                        <span className="block truncate font-medium text-ink">{clash.title}</span>
                        {isAuto && (
                          <Badge tone="neutral" size="sm" className="mt-0.5">
                            auto
                          </Badge>
                        )}
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <Badge size="sm" tone={typeTone(clash.type as ClashType)}>
                          {typeLabel(clash.type as ClashType)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <Severity level={clash.severity as ClashSeverity} />
                      </td>
                      <td className="px-5 py-3.5 min-w-0 max-w-[200px]">
                        <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
                          {clash.project_a_id ? (
                            <EntityLink kind="project" id={clash.project_a_id} muted>
                              {projectMap[clash.project_a_id] ?? clash.project_a_id.slice(0, 8) + "…"}
                            </EntityLink>
                          ) : null}
                          {clash.project_a_id && clash.project_b_id && (
                            <span className="text-ink-muted">/</span>
                          )}
                          {clash.project_b_id ? (
                            <EntityLink kind="project" id={clash.project_b_id} muted>
                              {projectMap[clash.project_b_id] ?? clash.project_b_id.slice(0, 8) + "…"}
                            </EntityLink>
                          ) : null}
                          {!clash.project_a_id && !clash.project_b_id && (
                            <span className="text-ink-muted">—</span>
                          )}
                        </span>
                      </td>
                      <td className="px-5 py-3.5 whitespace-nowrap">
                        <Badge size="sm" tone={statusTone(clash.status as ClashStatus)}>
                          {statusLabel(clash.status as ClashStatus)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5 max-w-xs">
                        {clash.over_allocation_pct != null && (
                          <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 mb-1 whitespace-nowrap tabular-nums">
                            +{Number(clash.over_allocation_pct).toFixed(0)}% over
                          </span>
                        )}
                        {clash.description && (
                          <p className="text-xs text-ink-secondary leading-snug line-clamp-2">
                            {clash.description}
                          </p>
                        )}
                        {clash.recommended_action && (
                          <p className="mt-1 text-xs text-ink-muted leading-snug line-clamp-2 italic">
                            {clash.recommended_action}
                          </p>
                        )}
                        {!clash.over_allocation_pct && !clash.description && !clash.recommended_action && (
                          <span className="text-ink-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">No clashes detected yet.</p>
            <p className="mt-1 text-xs text-ink-muted">
              Resource over-allocations are flagged here automatically.
            </p>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
