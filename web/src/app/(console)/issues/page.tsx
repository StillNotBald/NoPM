import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { NewIssueForm } from "@/components/registers/new-issue-form";

type PriorityLevel = "low" | "medium" | "high" | "urgent";
type IssueStatus = "open" | "in_progress" | "resolved" | "closed";

function priorityTone(p: PriorityLevel) {
  if (p === "urgent") return "danger" as const;
  if (p === "high") return "warning" as const;
  if (p === "medium") return "accent" as const;
  return "neutral" as const;
}

function statusTone(s: IssueStatus) {
  if (s === "resolved" || s === "closed") return "success" as const;
  if (s === "in_progress") return "warning" as const;
  return "neutral" as const;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function priorityLabel(p: PriorityLevel) {
  if (p === "urgent") return "Urgent";
  if (p === "high") return "High";
  if (p === "medium") return "Medium";
  return "Low";
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
    <div className="px-8 py-10 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-ink">Issue Register</h1>
          <p className="mt-0.5 text-sm text-ink-secondary">
            {issues?.length ?? 0} issue{(issues?.length ?? 0) !== 1 ? "s" : ""} across all projects
          </p>
        </div>
      </div>

      {/* New issue form */}
      <NewIssueForm projects={projects ?? []} />

      {/* Table */}
      <Card>
        {issues && issues.length > 0 ? (
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
                      <Badge tone={priorityTone(issue.priority as PriorityLevel)}>
                        {priorityLabel(issue.priority as PriorityLevel)}
                      </Badge>
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
            <p className="mt-1 text-xs text-ink-muted">Use the form above to log the first one.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
