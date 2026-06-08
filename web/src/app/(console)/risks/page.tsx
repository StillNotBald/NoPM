import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewRiskButton } from "@/components/registers/new-risk-form";

type SeverityLevel = "low" | "medium" | "high" | "critical";
type RiskStatus = "open" | "mitigating" | "closed" | "accepted";

function statusTone(s: RiskStatus) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  if (s === "open") return "info" as const;
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
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Risk Register"
        action={<NewRiskButton projects={projects ?? []} />}
      />

      {/* Table */}
      <Card>
        {risks && risks.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
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
                      <Severity level={risk.severity as SeverityLevel} />
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
            <p className="mt-1 text-xs text-ink-muted">Use “New Risk” to log the first one.</p>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
