import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

import { PageContainer } from "@/components/ui/page-container";
import { QueryError } from "@/components/ui/query-error";
import { KpiTile } from "@/components/ui/kpi-tile";
import { CsvDownloadButton } from "@/components/budget/csv-download-button";
import {
  memberUtilisation,
  workspaceSummary,
  fmtHours,
} from "@/lib/resource/utilisation";
import { ResourceActions } from "./resource-actions";
import { WorkloadChart } from "@/components/resources/workload-chart";
import { MembersList, type MemberListRow } from "@/components/resources/members-list";

interface ResourceMember {
  id: string;
  name: string;
  role_title: string | null;
  cost_rate: number | null;
  capacity_hours_per_week: number | null;
}

interface AllocationRow {
  member_id: string;
  allocation_pct: number;
}

function fmt_currency(amount: number | null, currency: string | null): string {
  if (amount == null) return "—";
  const sym = currency ?? "USD";
  return `${sym} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export const metadata: Metadata = { title: "Resources" };

export default async function ResourcesPage() {
  const db = await createClient();
  const {
    data: { user },
  } = await db.auth.getUser();
  if (!user) redirect("/login");

  // Fetch all resource members in the workspace (RLS-scoped)
  const { data: members, error: membersError } = await db
    .from("resource_members")
    .select("id, name, role_title, cost_rate, capacity_hours_per_week")
    .order("name");

  if (membersError) {
    return <QueryError what="resource members" message={membersError.message} />;
  }

  const rows = (members ?? []) as ResourceMember[];

  // Fetch all allocations for these members in one query
  const memberIds = rows.map((m) => m.id);
  const allocationsByMember: Record<string, number> = {};

  if (memberIds.length > 0) {
    const { data: allocations, error: allocError } = await db
      .from("allocations")
      .select("member_id, allocation_pct")
      .in("member_id", memberIds);

    if (allocError) return <QueryError what="allocations" message={allocError.message} />;

    for (const row of (allocations ?? []) as AllocationRow[]) {
      allocationsByMember[row.member_id] =
        (allocationsByMember[row.member_id] ?? 0) + (row.allocation_pct ?? 0);
    }
  }

  // Open tasks assigned to each member (assignee_id -> resource_members) — ties
  // task assignment to the same person who carries capacity + cost.
  const tasksByMember: Record<string, number> = {};
  if (memberIds.length > 0) {
    const { data: openTasks, error: tasksError } = await db
      .from("tasks")
      .select("assignee_id")
      .in("assignee_id", memberIds)
      .not("status_type", "in", '("completed","canceled")');
    if (tasksError) return <QueryError what="open tasks" message={tasksError.message} />;
    for (const t of (openTasks ?? []) as { assignee_id: string | null }[]) {
      if (t.assignee_id) tasksByMember[t.assignee_id] = (tasksByMember[t.assignee_id] ?? 0) + 1;
    }
  }

  // Compute per-member utilisation and workspace summary
  const memberStats = rows.map((m) =>
    memberUtilisation(allocationsByMember[m.id] ?? 0, m.capacity_hours_per_week),
  );

  const wsSummary = workspaceSummary(
    rows.map((m, i) => ({
      capacityHoursPerWeek: m.capacity_hours_per_week,
      totalAllocationPct: memberStats[i].allocatedPct,
    })),
  );

  const overAllocated = wsSummary.membersOverCapacity;

  // Flatten to plain serializable rows for the (client) MembersList/DataList —
  // DataList's column `cell` closures can't be passed from this server
  // component across the RSC boundary, so all display formatting happens
  // here and the client component only renders pre-computed strings/flags.
  const memberListRows: MemberListRow[] = rows.map((member, idx) => {
    const stats = memberStats[idx];
    const { allocatedPct: pct, allocatedHours, freeHours, isOver } = stats;
    return {
      id: member.id,
      name: member.name,
      roleTitle: member.role_title,
      costRateDisplay: fmt_currency(member.cost_rate, "USD"),
      capacityDisplay:
        member.capacity_hours_per_week != null ? `${fmtHours(member.capacity_hours_per_week)} h` : null,
      allocatedDisplay: allocatedHours != null ? `${fmtHours(allocatedHours)} h` : null,
      allocatedIsOver: isOver,
      freeDisplay: freeHours != null ? `${fmtHours(freeHours)} h` : null,
      freeIsNegative: freeHours != null && freeHours < 0,
      freeIsZero: freeHours === 0,
      openTasks: tasksByMember[member.id] ?? 0,
      utilisationPct: pct,
      barWidthPct: Math.min(pct, 100),
    };
  });

  const csvHeader = [
    "Name", "Role", "Cost rate / hr", "Capacity h/wk", "Allocated h/wk", "Free h/wk", "Open tasks", "Utilisation %",
  ];
  const csvRows = rows.map((m, idx) => {
    const st = memberStats[idx];
    return [
      m.name,
      m.role_title,
      m.cost_rate,
      m.capacity_hours_per_week,
      st.allocatedHours,
      st.freeHours,
      tasksByMember[m.id] ?? 0,
      Number(st.allocatedPct.toFixed(0)),
    ];
  });

  return (
    <PageContainer width="wide" className="space-y-6">
      <div className="space-y-6">
        <PageHeader
          title="Resources"
          exports={<CsvDownloadButton filename="resources.csv" header={csvHeader} rows={csvRows} />}
          action={<ResourceActions part="primary" />}
          secondaryActions={[
            ...(overAllocated > 0
              ? [
                  <div key="over-allocated" className="flex items-center gap-1.5 px-2 py-1.5 sm:px-0 sm:py-0">
                    <Badge tone="danger" size="sm">
                      {overAllocated} over-allocated
                    </Badge>
                  </div>,
                ]
              : []),
            <ResourceActions key="allocate" part="secondary" />,
          ]}
        />

        {/* Summary KPI row */}
        {rows.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4 print:grid-cols-4">
            <KpiTile
              label="Capacity / wk"
              value={wsSummary.totalCapacityHours > 0 ? `${fmtHours(wsSummary.totalCapacityHours)} h` : "—"}
            />
            <KpiTile
              label="Allocated / wk"
              value={wsSummary.totalCapacityHours > 0 ? `${fmtHours(wsSummary.totalAllocatedHours)} h` : "—"}
            />
            <KpiTile
              label="Utilisation"
              value={
                wsSummary.overallUtilisationPct != null ? `${wsSummary.overallUtilisationPct.toFixed(0)}%` : "—"
              }
              sub={
                wsSummary.overallUtilisationPct == null
                  ? undefined
                  : wsSummary.overallUtilisationPct > 100
                    ? "Over capacity"
                    : wsSummary.overallUtilisationPct >= 80
                      ? "Near capacity"
                      : "Healthy"
              }
            />
            <KpiTile
              label="Over-allocated"
              value={overAllocated}
              sub={overAllocated > 0 ? "Members above capacity" : "None over capacity"}
            />
          </div>
        )}

        {/* Workload chart — allocated vs capacity per member (L-13) */}
        {rows.length > 0 && (
          <WorkloadChart
            members={rows.map((m) => ({
              id: m.id,
              name: m.name,
              capacityHoursPerWeek: m.capacity_hours_per_week,
              totalAllocationPct: allocationsByMember[m.id] ?? 0,
            }))}
          />
        )}

        {/* Members table */}
        <Card>
          <CardHeader>
            <CardTitle>Team Members</CardTitle>
          </CardHeader>
          {rows.length === 0 ? (
            <CardBody>
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <p className="text-sm text-ink-muted">
                  No team members yet. Add one to track capacity and cost.
                </p>
                {/* Working "Add member" button in the empty state */}
                <ResourceActions variant="empty-state" />
              </div>
            </CardBody>
          ) : (
            <MembersList rows={memberListRows} />
          )}
        </Card>
      </div>
    </PageContainer>
  );
}
