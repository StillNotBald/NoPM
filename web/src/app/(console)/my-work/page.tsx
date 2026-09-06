import { redirect } from "next/navigation";
import Link from "next/link";
import { Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TaskRow, type MyTask } from "@/components/my-work/task-row";
import { RiskRow, type MyRisk } from "@/components/my-work/risk-row";
import { IssueRow, type MyIssue } from "@/components/my-work/issue-row";
import { ApprovalRow, type PendingApproval } from "@/components/my-work/approval-row";
import { HotStrip, type HotItem } from "@/components/my-work/hot-strip";

export const metadata = { title: "My Work — NoPM" };

// ── helpers ──────────────────────────────────────────────────────────────────

const today = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
};

// ── section wrapper ───────────────────────────────────────────────────────────

function Section({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {count > 0 && (
          <span className="rounded-full bg-sunken px-2 py-0.5 font-mono text-xs text-ink-muted">
            {count}
          </span>
        )}
      </CardHeader>
      <CardBody className="p-2">
        {count === 0 ? (
          <p className="px-3 py-4 text-sm text-ink-muted">{empty}</p>
        ) : (
          <div className="space-y-0.5">{children}</div>
        )}
      </CardBody>
    </Card>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default async function MyWorkPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Resolve profile → user id (auth uid = profile.id)
  const userId = user.id;

  // Resolve linked resource_member (if any — optional link)
  const { data: resourceMember } = await db
    .from("resource_members")
    .select("id")
    .eq("profile_id", userId)
    .maybeSingle();

  const todayDate = today();

  // ── Parallel fetches ──────────────────────────────────────────────────────
  const [
    tasksResult,
    risksResult,
    issuesResult,
    approvalsResult,
    projectsResult,
  ] = await Promise.all([
    // Tasks assigned to me — assignee is a resource_member; bridge via the
    // linked member (nil-uuid sentinel when this login has no resource_member).
    db
      .from("tasks")
      .select("id, name, status, status_type, priority, due_date, project_id")
      .eq("assignee_id", resourceMember?.id ?? "00000000-0000-0000-0000-000000000000")
      .not("status_type", "in", '("completed","canceled")')
      .order("due_date", { ascending: true, nullsFirst: false }),

    // Risks owned by me — open/mitigating
    db
      .from("risks")
      .select("id, title, severity, status, due_date, project_id, reference_id")
      .eq("owner_id", userId)
      .in("status", ["open", "mitigating"])
      .order("due_date", { ascending: true, nullsFirst: false }),

    // Issues owned by me — open/in_progress
    db
      .from("issues")
      .select("id, title, priority, status, due_date, project_id, reference_id")
      .eq("owner_id", userId)
      .in("status", ["open", "in_progress"])
      .order("due_date", { ascending: true, nullsFirst: false }),

    // Deletion requests pending approval — exclude ones I requested
    db
      .from("deletion_requests")
      .select("id, target_type, target_id, requested_by_label, reason, created_at")
      .eq("status", "pending")
      .neq("requested_by_id", userId)
      .order("created_at", { ascending: false }),

    // Projects lookup for names
    db.from("projects").select("id, name, code"),
  ]);

  // ── Hot Now — risks/issues across my projects scoped by high+/critical
  // We need open high/critical risks+issues for projects I own tasks in or
  // am a resource member on. We'll use the project ids we already have from tasks/risks/issues.
  const myProjectIds = new Set<string>();
  for (const t of tasksResult.data ?? []) myProjectIds.add(t.project_id);
  for (const r of risksResult.data ?? []) { if (r.project_id) myProjectIds.add(r.project_id); }
  for (const i of issuesResult.data ?? []) { if (i.project_id) myProjectIds.add(i.project_id); }

  // Also fetch high/critical open risks across my projects (not just ones I own)
  const [hotRisksResult, hotIssuesResult] = await (myProjectIds.size > 0
    ? Promise.all([
        db
          .from("risks")
          .select("id, title, severity, status, project_id")
          .in("project_id", [...myProjectIds])
          .in("status", ["open", "mitigating"])
          .in("severity", ["high", "critical"])
          .order("severity", { ascending: false }),
        db
          .from("issues")
          .select("id, title, priority, status, project_id")
          .in("project_id", [...myProjectIds])
          .in("status", ["open", "in_progress"])
          .in("priority", ["high", "urgent"])
          .order("priority", { ascending: false }),
      ])
    : Promise.resolve([{ data: [] }, { data: [] }]));

  // ── Build project name map ────────────────────────────────────────────────
  const projectMap = new Map<string, string>(
    (projectsResult.data ?? []).map((p) => [p.id, p.name]),
  );

  // ── Tasks ─────────────────────────────────────────────────────────────────
  const tasks: MyTask[] = (tasksResult.data ?? []).map((t) => ({
    ...t,
    project_name: t.project_id ? (projectMap.get(t.project_id) ?? null) : null,
    isOverdue:
      !!t.due_date && new Date(t.due_date) < todayDate,
  }));

  // ── Risks ─────────────────────────────────────────────────────────────────
  const risks: MyRisk[] = (risksResult.data ?? []).map((r) => ({
    ...r,
    project_name: r.project_id ? (projectMap.get(r.project_id) ?? null) : null,
  }));

  // ── Issues ────────────────────────────────────────────────────────────────
  const issues: MyIssue[] = (issuesResult.data ?? []).map((i) => ({
    ...i,
    priority: i.priority as string,
    project_name: i.project_id ? (projectMap.get(i.project_id) ?? null) : null,
  }));

  // ── Approvals ─────────────────────────────────────────────────────────────
  const approvals: PendingApproval[] = (approvalsResult.data ?? []) as PendingApproval[];

  // ── Hot strip ─────────────────────────────────────────────────────────────
  const hotItems: HotItem[] = [];

  // Overdue tasks
  for (const t of tasks) {
    if (t.isOverdue && t.due_date) {
      hotItems.push({
        kind: "task",
        id: t.id,
        label: t.name,
        project_id: t.project_id,
        project_name: t.project_name,
        reason: "overdue",
        due_date: t.due_date,
      });
    }
  }

  // High/critical open risks across my projects
  const seenRisks = new Set<string>();
  for (const r of hotRisksResult.data ?? []) {
    if (!seenRisks.has(r.id)) {
      seenRisks.add(r.id);
      hotItems.push({
        kind: "risk",
        id: r.id,
        label: r.title,
        project_id: r.project_id,
        project_name: r.project_id ? (projectMap.get(r.project_id) ?? null) : null,
        severity: r.severity,
        reason: "high_risk",
      });
    }
  }

  // High/urgent open issues across my projects
  const seenIssues = new Set<string>();
  for (const i of hotIssuesResult.data ?? []) {
    if (!seenIssues.has(i.id)) {
      seenIssues.add(i.id);
      hotItems.push({
        kind: "issue",
        id: i.id,
        label: i.title,
        project_id: i.project_id,
        project_name: i.project_id ? (projectMap.get(i.project_id) ?? null) : null,
        severity: i.priority,
        reason: "high_issue",
      });
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <PageHeader
        title="My Work"
        action={
          <Link
            href="/email-previews"
            className="inline-flex items-center gap-1.5 rounded text-xs text-ink-muted transition-colors hover:text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
          >
            <Mail size={14} />
            Email previews
          </Link>
        }
      />

      {/* Hot Now strip */}
      <Card>
        <CardHeader>
          <CardTitle>Hot now</CardTitle>
          {hotItems.length > 0 && (
            <span className="rounded-full bg-danger/10 px-2 py-0.5 font-mono text-xs font-medium text-danger">
              {hotItems.length}
            </span>
          )}
        </CardHeader>
        <CardBody className="p-2">
          <HotStrip items={hotItems} />
        </CardBody>
      </Card>

      {/* Tasks assigned to me */}
      <Section
        title="Tasks assigned to me"
        count={tasks.length}
        empty="No open tasks assigned to you."
      >
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </Section>

      {/* My risks / issues */}
      <div className="grid gap-6 md:grid-cols-2">
        <Section
          title="My risks"
          count={risks.length}
          empty="No open risks assigned to you."
        >
          {risks.map((r) => (
            <RiskRow key={r.id} risk={r} />
          ))}
        </Section>

        <Section
          title="My issues"
          count={issues.length}
          empty="No open issues assigned to you."
        >
          {issues.map((i) => (
            <IssueRow key={i.id} issue={i} />
          ))}
        </Section>
      </div>

      {/* Approvals awaiting me */}
      <Section
        title="Approvals awaiting me"
        count={approvals.length}
        empty="No deletion requests pending your approval."
      >
        {approvals.map((a) => (
          <ApprovalRow key={a.id} approval={a} />
        ))}
      </Section>
    </div>
  );
}
