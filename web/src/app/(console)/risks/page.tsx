import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { NewRiskForm } from "@/components/registers/new-risk-form";

type SeverityLevel = "low" | "medium" | "high" | "critical";
type RiskStatus = "open" | "mitigating" | "closed" | "accepted";

function severityTone(s: SeverityLevel) {
  if (s === "critical") return "danger" as const;
  if (s === "high") return "warning" as const;
  if (s === "medium") return "accent" as const;
  return "neutral" as const;
}

function statusTone(s: RiskStatus) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  return "neutral" as const;
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

  const [{ data: risks }, { data: projects }] = await Promise.all([
    db
      .from("risks")
      .select("id, title, project_id, severity, status, owner_id, due_date")
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
  ]);

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="px-8 py-10 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">Risk Register</h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {risks?.length ?? 0} risk{(risks?.length ?? 0) !== 1 ? "s" : ""} across all projects
          </p>
        </div>
      </div>

      {/* New risk form */}
      <NewRiskForm projects={projects ?? []} />

      {/* Table */}
      <Card>
        {risks && risks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Title
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Project
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Severity
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
                {risks.map((risk) => (
                  <tr key={risk.id} className="hover:bg-sunken transition-colors duration-100">
                    <td className="px-5 py-3.5 font-medium text-ink">{risk.title}</td>
                    <td className="px-5 py-3.5 text-ink-secondary">
                      {risk.project_id ? (projectMap[risk.project_id] ?? "—") : "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={severityTone(risk.severity as SeverityLevel)}>
                        {risk.severity}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={statusTone(risk.status as RiskStatus)}>
                        {risk.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5 text-ink-secondary">
                      {risk.owner_id ? risk.owner_id.slice(0, 8) + "…" : "—"}
                    </td>
                    <td className="px-5 py-3.5 text-ink-secondary tabular-nums">
                      {formatDate(risk.due_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">No risks recorded yet.</p>
            <p className="mt-1 text-xs text-ink-muted">Use the form above to log the first one.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
