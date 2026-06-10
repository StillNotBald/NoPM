import { redirect } from "next/navigation";
import { Suspense } from "react";
import { createClient } from "@/lib/supabase/server";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { NewIssueButton } from "@/components/registers/new-issue-form";
import { IssueRowButton } from "@/components/registers/issue-detail";
import { EntityLink } from "@/components/ui/entity-link";
import { IssueFocusOpener } from "@/components/registers/issue-focus-opener";

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
      .select(
        "id, reference_id, title, description, project_id, priority, status, due_date, resolution, raised_at, severity, issue_category, impact, resolution_eta, resolved_at",
      )
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

      {/* Deep-link auto-opener — opens inspector for ?issue=<id> */}
      <Suspense>
        <IssueFocusOpener
          issues={issues ?? []}
          projectMap={projectMap}
        />
      </Suspense>

      {/* Table */}
      <Card>
        {issues && issues.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
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
                {(issues ?? []).map((issue) => (
                  <IssueRowButton
                    key={issue.id}
                    issue={issue}
                    projectName={issue.project_id ? (projectMap[issue.project_id] ?? undefined) : undefined}
                  >
                    <td className="px-5 py-3 whitespace-nowrap">
                      {issue.reference_id ? (
                        <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted whitespace-nowrap">
                          {issue.reference_id}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 font-medium text-ink min-w-0 max-w-[240px]">
                      <span className="block truncate">{issue.title}</span>
                    </td>
                    <td className="px-5 py-3 min-w-0 max-w-[160px]">
                      {issue.project_id ? (
                        <EntityLink kind="project" id={issue.project_id} muted>
                          {projectMap[issue.project_id] ?? "—"}
                        </EntityLink>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <Severity level={issue.priority as PriorityLevel} />
                    </td>
                    <td className="px-5 py-3 whitespace-nowrap">
                      <Badge size="sm" tone={statusTone(issue.status as IssueStatus)}>
                        {statusLabel(issue.status as IssueStatus)}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-ink-secondary tabular-nums whitespace-nowrap text-xs">
                      {formatDate(issue.due_date)}
                    </td>
                  </IssueRowButton>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">No issues logged yet.</p>
            <p className="mt-1 text-xs text-ink-muted">Use &ldquo;New Issue&rdquo; to log the first one.</p>
          </div>
        )}
      </Card>
      </div>
    </div>
  );
}
