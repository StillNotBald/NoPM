"use client";

import { useEffect, useState } from "react";
import { Plus, AlertTriangle, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { useInspector } from "@/components/layout/app-shell";
import { cn } from "@/lib/cn";
import { apiGet } from "@/lib/api-client";
import { ActivityTable } from "@/components/tracking/activity-table";
import { GanttChart, type TaskDependency } from "@/components/tracking/gantt";
import { HistoryTimeline } from "@/components/tracking/history-timeline";
import { RiskForm } from "@/components/forms/risk-form";
import { IssueForm } from "@/components/forms/issue-form";

// ── Data shapes ───────────────────────────────────────────────────────────────

interface Project {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  program: string | null;
  rag_status: "not_started" | "red" | "amber" | "green" | "complete";
  completion_pct: number;
  start_date: string | null;
  target_date: string | null;
  currency: string;
  is_locked: boolean;
  lock_reason: string | null;
}

interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
  owner_id: string | null;
  sort_order: number;
}

interface Task {
  id: string;
  project_id: string;
  milestone_id: string | null;
  name: string;
  description: string | null;
  status: string;
  status_type: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  priority: "low" | "medium" | "high" | "urgent";
  start_date: string | null;
  due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
}

interface Risk {
  id: string;
  project_id: string;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  likelihood: "low" | "medium" | "high" | "critical";
  category: string;
  mitigation: string;
  status: "open" | "mitigating" | "closed" | "accepted";
  raised_at: string;
  due_date: string | null;
}

interface Issue {
  id: string;
  project_id: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  resolution: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  raised_at: string;
  due_date: string | null;
}

type Tab = "overview" | "activity" | "gantt" | "risks" | "issues" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "overview",  label: "Overview" },
  { id: "activity",  label: "Activity" },
  { id: "gantt",     label: "Gantt" },
  { id: "risks",     label: "Risks" },
  { id: "issues",    label: "Issues" },
  { id: "history",   label: "History" },
];

// Row shape returned by GET /api/resources (resource_members), used to build
// the id→name map for resolving owner/assignee UUIDs across detail views.
interface ResourceMemberRow {
  id: string;
  name: string;
  profile_id: string | null;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

function ragTone(s: Project["rag_status"]): BadgeTone {
  switch (s) {
    case "green":    return "success";
    case "amber":    return "warning";
    case "red":      return "danger";
    case "complete": return "success";
    default:         return "info";
  }
}

function ragLabel(s: Project["rag_status"]): string {
  switch (s) {
    case "not_started": return "In progress";
    case "red":         return "Delayed";
    case "amber":       return "At risk";
    case "green":       return "On track";
    case "complete":    return "Complete";
  }
}

function riskStatusTone(s: Risk["status"]): BadgeTone {
  switch (s) {
    case "closed":     return "success";
    case "accepted":   return "success";
    case "mitigating": return "warning";
    default:           return "info";
  }
}

function issueStatusTone(s: Issue["status"]): BadgeTone {
  switch (s) {
    case "resolved": return "success";
    case "closed":   return "success";
    case "in_progress": return "info";
    default:         return "warning";
  }
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ── Stat card ─────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: BadgeTone;
}) {
  const toneClass: Record<BadgeTone, string> = {
    neutral: "text-ink",
    accent:  "text-accent",
    info:    "text-info",
    success: "text-success",
    warning: "text-warning",
    danger:  "text-danger",
  };
  return (
    <Card className="p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">{label}</p>
      <p className={cn("mt-2 text-3xl font-semibold tabular-nums", toneClass[tone])}>{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-muted">{sub}</p>}
    </Card>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  project,
  milestones,
  tasks,
  risks,
  issues,
}: {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
  risks: Risk[];
  issues: Issue[];
}) {
  const completedMilestones = milestones.filter((m) => m.status === "completed").length;
  const tasksByStatus = {
    completed: tasks.filter((t) => t.status_type === "completed").length,
    inProgress: tasks.filter((t) => t.status_type === "started").length,
    todo:       tasks.filter((t) => t.status_type === "unstarted").length,
    backlog:    tasks.filter((t) => t.status_type === "backlog").length,
    canceled:   tasks.filter((t) => t.status_type === "canceled").length,
  };
  const openRisks   = risks.filter((r) => r.status === "open" || r.status === "mitigating").length;
  const openIssues  = issues.filter((i) => i.status === "open" || i.status === "in_progress").length;

  return (
    <div className="space-y-6">
      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <StatCard
          label="Completion"
          value={`${Math.round(project.completion_pct)}%`}
          tone="neutral"
        />
        <StatCard
          label="Milestones"
          value={milestones.length}
          sub={`${completedMilestones} completed`}
          tone="neutral"
        />
        <StatCard
          label="Open risks"
          value={openRisks}
          tone="neutral"
        />
        <StatCard
          label="Open issues"
          value={openIssues}
          tone="neutral"
        />
      </div>

      {/* Task breakdown */}
      <Card>
        <CardHeader>
          <CardTitle>Task breakdown</CardTitle>
          <span className="text-xs text-ink-muted">{tasks.length} total</span>
        </CardHeader>
        <CardBody>
          <div className="flex flex-wrap gap-3">
            {[
              { label: "Completed",   count: tasksByStatus.completed,  tone: "neutral" as BadgeTone, Icon: CheckCircle2 },
              { label: "In progress", count: tasksByStatus.inProgress,  tone: "neutral" as BadgeTone, Icon: Clock       },
              { label: "To do",       count: tasksByStatus.todo,        tone: "neutral" as BadgeTone, Icon: Clock       },
              { label: "Backlog",     count: tasksByStatus.backlog,     tone: "neutral" as BadgeTone, Icon: Clock       },
              { label: "Canceled",    count: tasksByStatus.canceled,    tone: "neutral" as BadgeTone, Icon: XCircle     },
            ].map(({ label, count, tone, Icon }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-lg border border-border-subtle bg-sunken px-4 py-3 min-w-[120px]"
              >
                <Icon size={16} className={cn(
                  tone === "success" ? "text-success" :
                  tone === "accent"  ? "text-accent"  :
                  "text-ink-muted"
                )} />
                <div>
                  <p className="text-lg font-semibold tabular-nums text-ink">{count}</p>
                  <p className="text-xs text-ink-muted">{label}</p>
                </div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>

      {/* RAG summary */}
      <Card>
        <CardHeader>
          <CardTitle>Project health</CardTitle>
        </CardHeader>
        <CardBody className="flex items-center gap-4">
          <Badge tone={ragTone(project.rag_status)} className="text-sm px-3 py-1">
            {ragLabel(project.rag_status)}
          </Badge>
          {project.is_locked && (
            <Badge tone="warning" className="flex items-center gap-1">
              <AlertTriangle size={12} />
              Locked{project.lock_reason ? ` — ${project.lock_reason}` : ""}
            </Badge>
          )}
          {project.target_date && (
            <span className="text-sm text-ink-secondary">
              Target: {fmtDate(project.target_date)}
            </span>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

// ── Risks tab ─────────────────────────────────────────────────────────────────

function RisksTab({ project, risks }: { project: Project; risks: Risk[] }) {
  const inspector = useInspector();

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">Risks</h2>
        {!project.is_locked && (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              inspector.open(<RiskForm projectId={project.id} />, "Add Risk")
            }
          >
            <Plus size={14} className="mr-1" />
            Risk
          </Button>
        )}
      </div>

      {risks.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-14 text-center">
          <p className="text-sm text-ink-muted">No risks recorded yet.</p>
          {!project.is_locked && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                inspector.open(<RiskForm projectId={project.id} />, "Add Risk")
              }
            >
              <Plus size={14} className="mr-1" />
              Add first risk
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
          <table className="w-full min-w-[560px] text-sm border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken/60">
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Title</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-24">Severity</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-24">Likelihood</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-28">Status</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-28">Due</th>
              </tr>
            </thead>
            <tbody>
              {risks.map((r, i) => (
                <tr
                  key={r.id}
                  className={cn(
                    "transition-colors hover:bg-sunken/40 cursor-pointer",
                    i < risks.length - 1 && "border-b border-border-subtle"
                  )}
                  onClick={() =>
                    inspector.open(<RiskForm projectId={project.id} risk={r} />, "Edit Risk")
                  }
                >
                  <td className="py-3 px-4">
                    <p className="font-medium text-ink">{r.title}</p>
                    {r.category && (
                      <p className="text-xs text-ink-muted">{r.category}</p>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={r.severity} />
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={r.likelihood} />
                  </td>
                  <td className="py-3 px-4">
                    <Badge tone={riskStatusTone(r.status)} className="capitalize">{r.status}</Badge>
                  </td>
                  <td className="py-3 px-4 text-xs text-ink-secondary">{fmtDate(r.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Issues tab ────────────────────────────────────────────────────────────────

function IssuesTab({ project, issues }: { project: Project; issues: Issue[] }) {
  const inspector = useInspector();

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">Issues</h2>
        {!project.is_locked && (
          <Button
            size="sm"
            variant="primary"
            onClick={() =>
              inspector.open(<IssueForm projectId={project.id} />, "Add Issue")
            }
          >
            <Plus size={14} className="mr-1" />
            Issue
          </Button>
        )}
      </div>

      {issues.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-14 text-center">
          <p className="text-sm text-ink-muted">No issues recorded yet.</p>
          {!project.is_locked && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                inspector.open(<IssueForm projectId={project.id} />, "Add Issue")
              }
            >
              <Plus size={14} className="mr-1" />
              Add first issue
            </Button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle bg-surface">
          <table className="w-full min-w-[480px] text-sm border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-sunken/60">
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted">Title</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-24">Priority</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-28">Status</th>
                <th className="py-2.5 px-4 text-left text-xs font-medium uppercase tracking-wide text-ink-muted w-28">Due</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((iss, i) => (
                <tr
                  key={iss.id}
                  className={cn(
                    "transition-colors hover:bg-sunken/40 cursor-pointer",
                    i < issues.length - 1 && "border-b border-border-subtle"
                  )}
                  onClick={() =>
                    inspector.open(<IssueForm projectId={project.id} issue={iss} />, "Edit Issue")
                  }
                >
                  <td className="py-3 px-4">
                    <p className="font-medium text-ink">{iss.title}</p>
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={iss.priority} />
                  </td>
                  <td className="py-3 px-4">
                    <Badge tone={issueStatusTone(iss.status)} className="capitalize">
                      {iss.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-xs text-ink-secondary">{fmtDate(iss.due_date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── ProjectTabs (main export) ─────────────────────────────────────────────────

export function ProjectTabs({
  project,
  milestones,
  tasks,
  risks,
  issues,
  dependencies = [],
}: {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
  risks: Risk[];
  issues: Issue[];
  dependencies?: TaskDependency[];
}) {
  const [active, setActive] = useState<Tab>("overview");

  // Resolve owner/assignee UUIDs to display names. Tasks/milestones reference
  // profiles(id), so we key the map by both resource-member id AND the linked
  // profile_id → name. Fetched once and shared down to the detail views.
  const [members, setMembers] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadMembers() {
      try {
        const rows = await apiGet<ResourceMemberRow[]>("/api/resources?limit=100");
        if (cancelled) return;
        const map: Record<string, string> = {};
        for (const r of rows) {
          if (r.name) {
            map[r.id] = r.name;
            if (r.profile_id) map[r.profile_id] = r.name;
          }
        }
        setMembers(map);
      } catch {
        // Non-fatal: fall back to short-id rendering in the detail views.
      }
    }

    void loadMembers();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-6">
      {/* Segmented tab bar — scrollable on mobile */}
      <div className="flex gap-1 overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden rounded-lg bg-sunken p-1 border border-border-subtle">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActive(tab.id)}
            className={cn(
              "shrink-0 rounded-md px-4 py-2.5 sm:py-1.5 text-sm font-medium transition-colors duration-150 min-h-[40px]",
              active === tab.id
                ? "bg-surface text-ink shadow-sm"
                : "text-ink-secondary hover:text-ink hover:bg-surface/50"
            )}
          >
            {tab.label}
            {/* Count badges for risks/issues */}
            {tab.id === "risks" && risks.length > 0 && (
              <span className="ml-1.5 rounded-full bg-warning/20 text-warning px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                {risks.filter((r) => r.status === "open" || r.status === "mitigating").length}
              </span>
            )}
            {tab.id === "issues" && issues.length > 0 && (
              <span className="ml-1.5 rounded-full bg-danger/20 text-danger px-1.5 py-0.5 text-[10px] font-semibold tabular-nums">
                {issues.filter((i) => i.status === "open" || i.status === "in_progress").length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {active === "overview" && (
        <OverviewTab
          project={project}
          milestones={milestones}
          tasks={tasks}
          risks={risks}
          issues={issues}
        />
      )}
      {active === "activity" && (
        <ActivityTable
          projectId={project.id}
          milestones={milestones}
          tasks={tasks}
          isLocked={project.is_locked}
          members={members}
        />
      )}
      {active === "gantt" && (
        <GanttChart
          projectId={project.id}
          milestones={milestones}
          tasks={tasks}
          dependencies={dependencies}
          isLocked={project.is_locked}
        />
      )}
      {active === "risks" && (
        <RisksTab project={project} risks={risks} />
      )}
      {active === "issues" && (
        <IssuesTab project={project} issues={issues} />
      )}
      {active === "history" && (
        <HistoryTimeline projectId={project.id} />
      )}
    </div>
  );
}
