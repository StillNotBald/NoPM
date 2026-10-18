"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plus, AlertTriangle, CheckCircle2, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { useInspector } from "@/components/layout/app-shell";
import { cn } from "@/lib/cn";
import { apiGet } from "@/lib/api-client";
import { ragLabel, ragTone } from "@/lib/status";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { countOpenIssues, countOpenRisks, isOpenRisk } from "@/lib/insight/open-status";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";
import { ActivityTable, type Task as RichTask } from "@/components/tracking/activity-table";
import { TaskDetailPanel } from "@/components/tracking/detail-panel";
import { GanttChart, type TaskDependency } from "@/components/tracking/gantt";
import { KanbanBoard } from "@/components/kanban/board";
import { HistoryTimeline } from "@/components/tracking/history-timeline";
import { RiskForm, type RiskResponseStrategy, type RiskCategoryValue, type RiskImpactArea } from "@/components/forms/risk-form";
import { IssueForm, type IssueSeverity, type IssueCategory } from "@/components/forms/issue-form";
import { RiskDetail } from "@/components/registers/risk-detail";
import { IssueDetail } from "@/components/registers/issue-detail";
import { CharterSection, type CharterDocument } from "@/components/tracking/charter-section";

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
  baseline_target_date: string | null;
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
  baseline_start_date: string | null;
  baseline_due_date: string | null;
  completion_pct: number;
  sort_order: number;
  assignee_id: string | null;
}

interface Risk {
  id: string;
  project_id: string;
  reference_id?: string | null;
  title: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  likelihood: "low" | "medium" | "high" | "critical";
  mitigation: string;
  status: "open" | "mitigating" | "closed" | "accepted";
  raised_at: string;
  due_date: string | null;
  probability_pct?: number | null;
  impact_score?: number | null;
  response_strategy?: RiskResponseStrategy;
  risk_category?: RiskCategoryValue | null;
  impact_area?: RiskImpactArea | null;
  impact_areas?: RiskImpactArea[];
  trigger?: string | null;
  residual_risk?: string | null;
}

interface Issue {
  id: string;
  project_id: string;
  reference_id?: string | null;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  resolution: string;
  status: "open" | "in_progress" | "resolved" | "closed";
  raised_at: string;
  due_date: string | null;
  severity?: IssueSeverity | null;
  issue_category?: IssueCategory | null;
  impact?: string | null;
  resolution_eta?: string | null;
  resolved_at?: string | null;
}

type Tab = "charter" | "overview" | "activity" | "board" | "gantt" | "risks" | "issues" | "history";

const TABS: { id: Tab; label: string }[] = [
  { id: "charter",   label: "Charter" },
  { id: "overview",  label: "Overview" },
  { id: "activity",  label: "Activity" },
  { id: "board",     label: "Board" },
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

/** Absolute date through the shared formatter, so this tab agrees with the rest of the app. */
function fmtDate(d: string | null, pref: DateDisplayPref): string {
  return d ? formatByPref(d, pref).absolute : "—";
}

// ── Overview helpers ──────────────────────────────────────────────────────────

/** Progress bar used inside the Overview section only. */
function OverviewProgressBar({
  pct,
  tone = "accent",
}: {
  pct: number;
  tone?: "accent" | "success" | "warning" | "danger" | "info";
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const barClass =
    tone === "success" ? "bg-success" :
    tone === "warning" ? "bg-warning" :
    tone === "danger"  ? "bg-danger"  :
    tone === "info"    ? "bg-info"    :
    "bg-accent";
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-well">
      <div
        className={cn("h-full rounded-full transition-all", barClass)}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

/** Mini stat chip — label + number in a tight bordered pill. */
function MiniChip({
  label,
  count,
  tone = "neutral",
}: {
  label: string;
  count: number;
  tone?: BadgeTone;
}) {
  const bg: Record<BadgeTone, string> = {
    neutral: "bg-well text-ink-secondary",
    accent:  "bg-accent/10 text-accent",
    info:    "bg-info/10 text-info-ink",
    success: "bg-success/10 text-success-ink",
    warning: "bg-warning/10 text-warning-ink",
    danger:  "bg-danger/10 text-danger-ink",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-border-subtle px-2.5 py-1 text-xs font-medium",
        bg[tone],
      )}
    >
      <span className="font-mono tabular-nums font-semibold">{count}</span>
      <span className="text-ink-muted font-normal">{label}</span>
    </span>
  );
}

// ── Overview tab ──────────────────────────────────────────────────────────────

function OverviewTab({
  project,
  milestones,
  tasks,
  risks,
  issues,
  members,
  membersReady,
}: {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
  risks: Risk[];
  issues: Issue[];
  members: Record<string, string>;
  /** False until /api/resources answers: names are not known yet, so don't print ids. */
  membersReady: boolean;
}) {
  const pref = useDateDisplayPref();

  // ── Derived data ───────────────────────────────────────────────────────────

  const pct = Math.round(project.completion_pct);

  // Milestone status breakdown
  const milestoneBreakdown = {
    completed:   milestones.filter((m) => m.status === "completed").length,
    on_track:    milestones.filter((m) => m.status === "on_track").length,
    at_risk:     milestones.filter((m) => m.status === "at_risk").length,
    delayed:     milestones.filter((m) => m.status === "delayed").length,
    not_started: milestones.filter((m) => m.status === "not_started").length,
  };
  const milestoneCompletedPct =
    milestones.length > 0
      ? Math.round((milestoneBreakdown.completed / milestones.length) * 100)
      : 0;

  // Task status breakdown
  const tasksByStatus = {
    completed: tasks.filter((t) => t.status_type === "completed").length,
    inProgress: tasks.filter((t) => t.status_type === "started").length,
    todo:       tasks.filter((t) => t.status_type === "unstarted").length,
    backlog:    tasks.filter((t) => t.status_type === "backlog").length,
    canceled:   tasks.filter((t) => t.status_type === "canceled").length,
  };

  // Risk posture — open only (open + mitigating)
  const openRisksAll = risks.filter((r) => isOpenRisk(r.status));
  const riskBySeverity = {
    critical: openRisksAll.filter((r) => r.severity === "critical").length,
    high:     openRisksAll.filter((r) => r.severity === "high").length,
    medium:   openRisksAll.filter((r) => r.severity === "medium").length,
    low:      openRisksAll.filter((r) => r.severity === "low").length,
  };
  const openIssues = countOpenIssues(issues);

  // Schedule
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const targetDate = project.target_date ? new Date(project.target_date) : null;
  let daysRemaining: number | null = null;
  let isOverdue = false;
  if (targetDate) {
    targetDate.setHours(0, 0, 0, 0);
    daysRemaining = Math.round(
      (targetDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
    );
    isOverdue = daysRemaining < 0;
  }
  const overdueTasks = tasks.filter((t) => {
    if (!t.due_date) return false;
    if (t.status_type === "completed" || t.status_type === "canceled") return false;
    const d = new Date(t.due_date);
    d.setHours(0, 0, 0, 0);
    return d < today;
  }).length;

  // Team — distinct assignees with task counts
  const assigneeCounts = new Map<string, number>();
  for (const t of tasks) {
    if (!t.assignee_id) continue;
    assigneeCounts.set(t.assignee_id, (assigneeCounts.get(t.assignee_id) ?? 0) + 1);
  }
  const teamRows = [...assigneeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => ({
      id,
      // a name or nothing: an eight-character id fragment is not a person
      name: members[id] ?? "Unknown member",
      count,
    }));

  // Progress bar tone based on RAG
  const progressTone =
    project.rag_status === "red"     ? "danger"  :
    project.rag_status === "amber"   ? "warning" :
    project.rag_status === "complete" ? "success" :
    "accent";

  return (
    <div className="space-y-4">

      {/* ── Row 1: Progress ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">

        {/* Completion */}
        <Card className="p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Completion
            </p>
            <Badge tone={ragTone(project.rag_status)}>
              {ragLabel(project.rag_status)}
            </Badge>
          </div>
          <div className="flex items-end gap-3">
            <span className="font-mono text-4xl font-semibold tabular-nums text-ink leading-none">
              {pct}%
            </span>
            {project.is_locked && (
              <Badge tone="warning" className="mb-0.5 gap-1">
                <AlertTriangle size={10} />
                Locked
              </Badge>
            )}
          </div>
          <OverviewProgressBar pct={pct} tone={progressTone} />
        </Card>

        {/* Milestones */}
        <Card className="p-5 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Milestones
            </p>
            <span className="font-mono text-xs text-ink-muted tabular-nums">
              {milestones.length} total
            </span>
          </div>
          {milestones.length === 0 ? (
            <p className="text-xs text-ink-muted mt-1">No milestones yet.</p>
          ) : (
            <>
              <OverviewProgressBar pct={milestoneCompletedPct} tone="success" />
              <div className="flex flex-wrap gap-1.5 mt-0.5">
                {milestoneBreakdown.completed > 0 && (
                  <MiniChip label="completed" count={milestoneBreakdown.completed} tone="success" />
                )}
                {milestoneBreakdown.on_track > 0 && (
                  <MiniChip label="on track" count={milestoneBreakdown.on_track} tone="accent" />
                )}
                {milestoneBreakdown.at_risk > 0 && (
                  <MiniChip label="at risk" count={milestoneBreakdown.at_risk} tone="warning" />
                )}
                {milestoneBreakdown.delayed > 0 && (
                  <MiniChip label="delayed" count={milestoneBreakdown.delayed} tone="danger" />
                )}
                {milestoneBreakdown.not_started > 0 && (
                  <MiniChip label="not started" count={milestoneBreakdown.not_started} tone="neutral" />
                )}
              </div>
            </>
          )}
        </Card>

        {/* Tasks */}
        <Card className="p-5 flex flex-col gap-3 sm:col-span-2 xl:col-span-1">
          <div className="flex items-center justify-between">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Tasks
            </p>
            <span className="font-mono text-xs text-ink-muted tabular-nums">
              {tasks.length} total
            </span>
          </div>
          {tasks.length === 0 ? (
            <p className="text-xs text-ink-muted mt-1">No tasks yet.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {tasksByStatus.completed > 0 && (
                <MiniChip label="done" count={tasksByStatus.completed} tone="success" />
              )}
              {tasksByStatus.inProgress > 0 && (
                <MiniChip label="in progress" count={tasksByStatus.inProgress} tone="info" />
              )}
              {tasksByStatus.todo > 0 && (
                <MiniChip label="to do" count={tasksByStatus.todo} tone="neutral" />
              )}
              {tasksByStatus.backlog > 0 && (
                <MiniChip label="backlog" count={tasksByStatus.backlog} tone="neutral" />
              )}
              {tasksByStatus.canceled > 0 && (
                <MiniChip label="canceled" count={tasksByStatus.canceled} tone="neutral" />
              )}
            </div>
          )}
        </Card>
      </div>

      {/* ── Row 2: Risk posture + Schedule ────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">

        {/* Risk posture */}
        <Card className="p-5 flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Risk posture
          </p>
          {openRisksAll.length === 0 && openIssues === 0 ? (
            <div className="flex items-center gap-2 mt-0.5">
              <CheckCircle2 size={14} className="text-success-ink" />
              <span className="text-xs text-success-ink font-medium">No open risks or issues</span>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5 mt-0.5">
              {riskBySeverity.critical > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-danger/30 bg-danger/10 px-2.5 py-1 text-xs font-medium text-danger-ink">
                  <span className="font-mono tabular-nums font-semibold">{riskBySeverity.critical}</span>
                  <span className="text-danger-ink/80 font-normal">critical</span>
                </span>
              )}
              {riskBySeverity.high > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-md border border-sev-high/30 bg-sev-high/10 px-2.5 py-1 text-xs font-medium text-sev-high-ink">
                  <span className="font-mono tabular-nums font-semibold">{riskBySeverity.high}</span>
                  <span className="opacity-80 font-normal">high</span>
                </span>
              )}
              {riskBySeverity.medium > 0 && (
                <MiniChip label="medium" count={riskBySeverity.medium} tone="warning" />
              )}
              {riskBySeverity.low > 0 && (
                <MiniChip label="low" count={riskBySeverity.low} tone="neutral" />
              )}
              {openIssues > 0 && (
                <MiniChip label="open issues" count={openIssues} tone="danger" />
              )}
            </div>
          )}
        </Card>

        {/* Schedule */}
        <Card className="p-5 flex flex-col gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            Schedule
          </p>
          <div className="flex flex-col gap-2 mt-0.5">
            {project.target_date ? (
              <>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-ink-secondary">
                    Target:
                  </span>
                  <span className="font-mono text-xs font-medium text-ink tabular-nums">
                    {fmtDate(project.target_date, pref)}
                  </span>
                  {daysRemaining !== null && project.rag_status !== "complete" && (
                    <Badge
                      tone={isOverdue ? "danger" : daysRemaining <= 14 ? "warning" : "success"}
                    >
                      {isOverdue
                        ? `${Math.abs(daysRemaining)}d overdue`
                        : daysRemaining === 0
                        ? "due today"
                        : `${daysRemaining}d left`}
                    </Badge>
                  )}
                </div>
                {overdueTasks > 0 && (
                  <div className="flex items-center gap-1.5">
                    <Clock size={12} className="text-danger-ink shrink-0" />
                    <span className="text-xs text-danger-ink font-medium tabular-nums">
                      {overdueTasks} overdue {overdueTasks === 1 ? "task" : "tasks"}
                    </span>
                  </div>
                )}
                {overdueTasks === 0 && (
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 size={12} className="text-success-ink shrink-0" />
                    <span className="text-xs text-success-ink font-medium">
                      No overdue tasks
                    </span>
                  </div>
                )}
              </>
            ) : (
              <span className="text-xs text-ink-muted">No target date set.</span>
            )}
          </div>
        </Card>
      </div>

      {/* ── Row 3: Team ───────────────────────────────────────────────────── */}
      {teamRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Team on project</CardTitle>
            <span className="text-xs text-ink-muted">
              {teamRows.length} {teamRows.length === 1 ? "member" : "members"}
            </span>
          </CardHeader>
          <CardBody className="p-0">
            {!membersReady ? (
              <p className="px-5 py-3 text-sm text-ink-muted" role="status">
                Loading team…
              </p>
            ) : (
            <div className="divide-y divide-border-subtle">
              {teamRows.map(({ id, name, count }) => (
                <div
                  key={id}
                  className="flex items-center justify-between px-5 py-3"
                >
                  <div className="flex items-center gap-2.5">
                    {/* Avatar initials */}
                    <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[11px] font-semibold uppercase text-accent">
                      {name.split(" ").map((n) => n[0]).slice(0, 2).join("")}
                    </span>
                    <span className="text-sm font-medium text-ink">{name}</span>
                  </div>
                  <span className="font-mono text-xs tabular-nums text-ink-muted">
                    {count} {count === 1 ? "task" : "tasks"}
                  </span>
                </div>
              ))}
            </div>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}

// ── Risks tab ─────────────────────────────────────────────────────────────────

function RisksTab({ project, risks }: { project: Project; risks: Risk[] }) {
  const inspector = useInspector();
  const pref = useDateDisplayPref();

  const openRisk = (r: Risk) =>
    inspector.open(
      <RiskDetail risk={r} projectName={project.name} />,
      r.reference_id ? `Risk ${r.reference_id}` : "Risk Detail",
    );

  // Phone (<md) cards: the 560px table cut Severity to "H" and hid Status/Due.
  const cardColumns: DataListColumn<Risk>[] = [
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (r) => (
        <>
          {r.reference_id && (
            <span className="mr-1.5 font-mono text-2xs font-normal text-ink-muted">{r.reference_id}</span>
          )}
          {r.title}
        </>
      ),
    },
    { key: "severity", header: "Severity", badge: true, cell: (r) => <Severity level={r.severity} /> },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (r) => (
        <Badge size="sm" tone={riskStatusTone(r.status)} className="capitalize">
          {r.status}
        </Badge>
      ),
    },
    { key: "likelihood", header: "Likelihood", cell: (r) => <span className="capitalize">{r.likelihood}</span> },
    { key: "due", header: "Due", cell: (r) => <span className="tabular-nums">{fmtDate(r.due_date, pref)}</span> },
  ];

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
        <>
        <DataList
          className="rounded-lg border border-border-subtle bg-surface md:hidden"
          columns={cardColumns}
          rows={risks}
          rowKey={(r) => r.id}
          onRowClick={openRisk}
        />
        <div className="hidden overflow-x-auto rounded-lg border border-border-subtle bg-surface md:block">
          <table className="w-full min-w-[560px] text-sm border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-well/60">
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
                    "transition-colors hover:bg-well/40 cursor-pointer focus-within:bg-well/40",
                    i < risks.length - 1 && "border-b border-border-subtle"
                  )}
                  onClick={() => openRisk(r)}
                >
                  <td className="py-3 px-4 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {r.reference_id && (
                        <span className="font-mono text-2xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted shrink-0">
                          {r.reference_id}
                        </span>
                      )}
                      <button
                        type="button"
                        className="focus-ring rounded-sm text-left font-medium text-ink truncate hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRisk(r);
                        }}
                      >
                        {r.title}
                      </button>
                    </div>
                    {r.risk_category && (
                      <p className="text-xs text-ink-muted mt-0.5 truncate capitalize">{r.risk_category.replace(/_/g, " ")}</p>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={r.severity} />
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={r.likelihood} />
                  </td>
                  <td className="py-3 px-4">
                    <Badge size="sm" tone={riskStatusTone(r.status)} className="capitalize">{r.status}</Badge>
                  </td>
                  <td className="py-3 px-4 text-xs text-ink-secondary tabular-nums whitespace-nowrap">{fmtDate(r.due_date, pref)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  );
}

// ── Issues tab ────────────────────────────────────────────────────────────────

function IssuesTab({ project, issues }: { project: Project; issues: Issue[] }) {
  const inspector = useInspector();
  const pref = useDateDisplayPref();

  const openIssue = (iss: Issue) =>
    inspector.open(
      <IssueDetail issue={iss} projectName={project.name} />,
      iss.reference_id ? `Issue ${iss.reference_id}` : "Issue Detail",
    );

  const cardColumns: DataListColumn<Issue>[] = [
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (iss) => (
        <>
          {iss.reference_id && (
            <span className="mr-1.5 font-mono text-2xs font-normal text-ink-muted">{iss.reference_id}</span>
          )}
          {iss.title}
        </>
      ),
    },
    { key: "priority", header: "Priority", badge: true, cell: (iss) => <Severity level={iss.priority} /> },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (iss) => (
        <Badge size="sm" tone={issueStatusTone(iss.status)} className="capitalize">
          {iss.status.replace("_", " ")}
        </Badge>
      ),
    },
    { key: "due", header: "Due", cell: (iss) => <span className="tabular-nums">{fmtDate(iss.due_date, pref)}</span> },
  ];

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
        <>
        <DataList
          className="rounded-lg border border-border-subtle bg-surface md:hidden"
          columns={cardColumns}
          rows={issues}
          rowKey={(iss) => iss.id}
          onRowClick={openIssue}
        />
        <div className="hidden overflow-x-auto rounded-lg border border-border-subtle bg-surface md:block">
          <table className="w-full min-w-[480px] text-sm border-collapse">
            <thead>
              <tr className="border-b border-border-subtle bg-well/60">
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
                    "transition-colors hover:bg-well/40 cursor-pointer focus-within:bg-well/40",
                    i < issues.length - 1 && "border-b border-border-subtle"
                  )}
                  onClick={() => openIssue(iss)}
                >
                  <td className="py-3 px-4 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      {iss.reference_id && (
                        <span className="font-mono text-2xs bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted shrink-0">
                          {iss.reference_id}
                        </span>
                      )}
                      <button
                        type="button"
                        className="focus-ring rounded-sm text-left font-medium text-ink truncate hover:underline"
                        onClick={(e) => {
                          e.stopPropagation();
                          openIssue(iss);
                        }}
                      >
                        {iss.title}
                      </button>
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <Severity level={iss.priority} />
                  </td>
                  <td className="py-3 px-4">
                    <Badge size="sm" tone={issueStatusTone(iss.status)} className="capitalize">
                      {iss.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="py-3 px-4 text-xs text-ink-secondary tabular-nums whitespace-nowrap">{fmtDate(iss.due_date, pref)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
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
  charterDoc = null,
}: {
  project: Project;
  milestones: Milestone[];
  tasks: Task[];
  risks: Risk[];
  issues: Issue[];
  dependencies?: TaskDependency[];
  charterDoc?: CharterDocument | null;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  // Active tab lives in the URL (?tab=). A ?task= deep link with no explicit
  // tab lands on Activity, where the task panel opens; otherwise Overview.
  const tabParam = searchParams.get("tab");
  const active: Tab = TABS.some((t) => t.id === tabParam)
    ? (tabParam as Tab)
    : searchParams.get("task")
      ? "activity"
      : "overview";
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const setActive = useCallback(
    (id: Tab) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("tab", id);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [router, pathname, searchParams],
  );
  function onTabKeyDown(e: React.KeyboardEvent, index: number) {
    let next = -1;
    if (e.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    setActive(id);
    tabRefs.current[id]?.focus();
  }

  // Resolve owner/assignee UUIDs to display names. Tasks/milestones reference
  // profiles(id), so we key the map by both resource-member id AND the linked
  // profile_id → name. Fetched once and shared down to the detail views.
  const [members, setMembers] = useState<Record<string, string>>({});
  const [membersReady, setMembersReady] = useState(false);

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
      } finally {
        if (!cancelled) setMembersReady(true);
      }
    }

    void loadMembers();
    return () => {
      cancelled = true;
    };
  }, []);

  // Deep link: /projects/:id?task=<id> (entityHref for tasks, used by the
  // /tasks list, My Work and search) opens that task's detail panel on the
  // Activity tab, once, after member names are available (R-94 residual).
  const inspector = useInspector();
  const focusTaskId = searchParams.get("task");
  const openedTaskRef = useRef<string | null>(null);
  useEffect(() => {
    if (!focusTaskId || !membersReady || openedTaskRef.current === focusTaskId) return;
    const task = tasks.find((t) => t.id === focusTaskId);
    if (!task) return;
    openedTaskRef.current = focusTaskId;
    inspector.open(
      <TaskDetailPanel
        task={task as unknown as RichTask}
        milestones={milestones}
        tasks={tasks as unknown as RichTask[]}
        members={members}
        isLocked={project.is_locked}
      />,
      task.name,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusTaskId, membersReady]);

  return (
    <div className="space-y-6">
      {/* Tab bar: WAI-ARIA tabs, URL-driven. Scrolls horizontally on small
          screens; the edge fade signals there are more tabs off-screen. */}
      <div className="relative">
        <div
          role="tablist"
          aria-label="Project sections"
          className="flex gap-1 overflow-x-auto snap-x snap-mandatory whitespace-nowrap [scrollbar-width:thin] rounded-lg bg-well p-1 border border-border-subtle"
        >
          {TABS.map((tab, i) => (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`project-tab-${tab.id}`}
              aria-selected={active === tab.id}
              aria-controls="project-tabpanel"
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={cn(
                "focus-ring shrink-0 snap-start rounded-md px-4 py-2.5 sm:py-1.5 text-sm font-medium transition-colors duration-150 min-h-[44px] sm:min-h-0",
                active === tab.id
                  ? "bg-surface text-ink shadow-sm"
                  : "text-ink-secondary hover:text-ink hover:bg-surface/50"
              )}
            >
              {tab.label}
              {tab.id === "risks" && risks.length > 0 && (
                <Badge tone="warning" size="sm" className="ml-1.5 tabular-nums">
                  {countOpenRisks(risks)}
                </Badge>
              )}
              {tab.id === "issues" && issues.length > 0 && (
                <Badge tone="danger" size="sm" className="ml-1.5 tabular-nums">
                  {countOpenIssues(issues)}
                </Badge>
              )}
            </button>
          ))}
        </div>
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-px right-px w-8 rounded-r-lg bg-gradient-to-l from-well to-transparent sm:hidden"
        />
      </div>

      {/* Tab content */}
      <div role="tabpanel" id="project-tabpanel" aria-labelledby={`project-tab-${active}`} tabIndex={0} className="space-y-6 focus-ring rounded-lg">
      {active === "charter" && (
        <CharterSection
          project={project}
          charterDoc={charterDoc}
        />
      )}
      {active === "overview" && (
        <OverviewTab
          project={project}
          milestones={milestones}
          tasks={tasks}
          risks={risks}
          issues={issues}
          members={members}
          membersReady={membersReady}
        />
      )}
      {active === "activity" && (
        <ActivityTable
          projectId={project.id}
          milestones={milestones}
          tasks={tasks}
          isLocked={project.is_locked}
          members={members}
          membersReady={membersReady}
        />
      )}
      {active === "board" && (
        <KanbanBoard
          projectId={project.id}
          isLocked={project.is_locked}
          // ProjectTabs' Task lacks the board's index signature; the runtime
          // shape (id/name/status_type/priority) matches, so cast to its prop type.
          tasks={tasks as unknown as Parameters<typeof KanbanBoard>[0]["tasks"]}
          // Card tap opens the same TaskDetailPanel the Activity tab uses
          // (R-94 — mobile board, drag is desktop-only there).
          milestones={milestones}
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
    </div>
  );
}
