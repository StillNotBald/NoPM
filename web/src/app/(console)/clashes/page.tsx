import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type ClashType = "schedule" | "resource" | "dependency";
type ClashSeverity = "low" | "medium" | "high" | "critical";
type ClashStatus = "open" | "investigating" | "resolved";

function typeTone(t: ClashType) {
  if (t === "resource") return "warning" as const;
  if (t === "dependency") return "danger" as const;
  return "neutral" as const;
}

function severityTone(s: ClashSeverity) {
  if (s === "critical") return "danger" as const;
  if (s === "high") return "warning" as const;
  if (s === "medium") return "accent" as const;
  return "neutral" as const;
}

function statusTone(s: ClashStatus) {
  if (s === "resolved") return "success" as const;
  if (s === "investigating") return "warning" as const;
  return "neutral" as const;
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
      .select("id, title, type, severity, project_a_id, project_b_id, status")
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
  ]);

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  function projectLabel(id: string | null) {
    if (!id) return null;
    return projectMap[id] ?? id.slice(0, 8) + "…";
  }

  return (
    <div className="px-8 py-10 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">Clash Register</h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {clashes?.length ?? 0} clash{(clashes?.length ?? 0) !== 1 ? "es" : ""} detected across the workspace
          </p>
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Badge tone="neutral" className="text-xs">auto</Badge>
        <span>= system-detected resource over-allocation</span>
      </div>

      {/* Table */}
      <Card>
        {clashes && clashes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Title
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Type
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Severity
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Projects
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {clashes.map((clash) => {
                  const isAuto = clash.type === "resource";
                  const aLabel = projectLabel(clash.project_a_id);
                  const bLabel = projectLabel(clash.project_b_id);

                  return (
                    <tr
                      key={clash.id}
                      className="hover:bg-sunken transition-colors duration-100"
                    >
                      <td className="px-5 py-3.5">
                        <span className="font-medium text-ink">{clash.title}</span>
                        {isAuto && (
                          <Badge tone="neutral" className="ml-2 text-xs">
                            auto
                          </Badge>
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge tone={typeTone(clash.type as ClashType)}>
                          {typeLabel(clash.type as ClashType)}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge tone={severityTone(clash.severity as ClashSeverity)}>
                          {clash.severity}
                        </Badge>
                      </td>
                      <td className="px-5 py-3.5 text-ink-secondary">
                        {aLabel && bLabel ? (
                          <span>
                            {aLabel}
                            <span className="mx-1 text-ink-muted">/</span>
                            {bLabel}
                          </span>
                        ) : aLabel ? (
                          aLabel
                        ) : bLabel ? (
                          bLabel
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-5 py-3.5">
                        <Badge tone={statusTone(clash.status as ClashStatus)}>
                          {statusLabel(clash.status as ClashStatus)}
                        </Badge>
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
  );
}
