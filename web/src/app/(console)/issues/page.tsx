import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewIssueButton } from "@/components/registers/new-issue-form";

type PriorityLevel = "low" | "medium" | "high" | "urgent";
type IssueStatus = "open" | "in_progress" | "resolved" | "closed";

function statusTone(s: IssueStatus) {
  if (s === "resolved" || s === "closed") return "success" as const;
  if (s === "in_progress") return "info" as const;
  if (s === "open") return "warning" as const;
  return "neutral" as const;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function statusLabel(s: IssueStatus) {
  if (s === "in_progress") return "In Progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export default async function IssuesPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  const [{ data: issues }, { data: projects }] = await Promise.all([
    db
      .from("issues")
      .select("id, title, project_id, priority, status, due_date")
      .order("created_at", { ascending: false }),
    db.from("projects").select("id, name").order("name"),
  ]);

  const projectMap = Object.fromEntries((projects ?? []).map((p) => [p.id, p.name]));

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Issue Register"
        action={<NewIssueButton projects={projects ?? []} />}
      />

      {/* Table */}
      <Card>
        {issues && issues.length > 0 ? (
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
                    Priority
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-5 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Due
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {issues.map((issue) => (
                  <tr key={issue.id} className="hover:bg-sunken transition-colors duration-100">
                    <td className="px-5 py-3.5 font-medium text-ink">{issue.title}</td>
                    <td className="px-5 py-3.5 text-ink-secondary">
                      {issue.project_id ? (projectMap[issue.project_id] ?? "—") : "—"}
                    </td>
                    <td className="px-5 py-3.5">
                      <Severity level={issue.priority as PriorityLevel} />
                    </td>
                    <td className="px-5 py-3.5">
                      <Badge tone={statusTone(issue.status as IssueStatus)}>
                        {statusLabel(issue.status as IssueStatus)}
                      </Badge>
                    </td>
                    <td className="px-5 py-3.5 text-ink-secondary tabular-nums">
                      {formatDate(issue.due_date)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">No issues logged yet.</p>
            <p className="mt-1 text-xs text-ink-muted">Use “New Issue” to log the first one.</p>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
