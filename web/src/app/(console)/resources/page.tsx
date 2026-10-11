import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";

import { cn } from "@/lib/cn";
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
    return (
      <div className="px-4 py-5 sm:px-6 lg:px-8">
        <p className="text-sm text-danger">Failed to load resource members.</p>
      </div>
    );
  }

  const rows = (members ?? []) as ResourceMember[];

  // Fetch all allocations for these members in one query
  const memberIds = rows.map((m) => m.id);
  const allocationsByMember: Record<string, number> = {};

  if (memberIds.length > 0) {
    const { data: allocations } = await db
      .from("allocations")
      .select("member_id, allocation_pct")
      .in("member_id", memberIds);

    for (const row of (allocations ?? []) as AllocationRow[]) {
      allocationsByMember[row.member_id] =
        (allocationsByMember[row.member_id] ?? 0) + (row.allocation_pct ?? 0);
    }
  }

  // Open tasks assigned to each member (assignee_id -> resource_members) — ties
  // task assignment to the same person who carries capacity + cost.
  const tasksByMember: Record<string, number> = {};
  if (memberIds.length > 0) {
    const { data: openTasks } = await db
      .from("tasks")
      .select("assignee_id")
      .in("assignee_id", memberIds)
      .not("status_type", "in", '("completed","canceled")');
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

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title="Resources"
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

        {/* Summary cards */}
        {rows.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {/* Total capacity */}
            <Card>
              <CardBody className="py-4">
                <p className="text-xs text-ink-muted uppercase tracking-wide">Capacity / wk</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-ink tabular-nums">
                  {wsSummary.totalCapacityHours > 0
                    ? `${fmtHours(wsSummary.totalCapacityHours)} h`
                    : <span className="text-ink-muted">—</span>}
                </p>
              </CardBody>
            </Card>

            {/* Total allocated hours */}
            <Card>
              <CardBody className="py-4">
                <p className="text-xs text-ink-muted uppercase tracking-wide">Allocated / wk</p>
                <p className="mt-1 font-mono text-2xl font-semibold text-ink tabular-nums">
                  {wsSummary.totalCapacityHours > 0
                    ? `${fmtHours(wsSummary.totalAllocatedHours)} h`
                    : <span className="text-ink-muted">—</span>}
                </p>
              </CardBody>
            </Card>

            {/* Overall utilisation % */}
            <Card>
              <CardBody className="py-4">
                <p className="text-xs text-ink-muted uppercase tracking-wide">Utilisation</p>
                <p
                  className={cn(
                    "mt-1 font-mono text-2xl font-semibold tabular-nums",
                    wsSummary.overallUtilisationPct == null
                      ? "text-ink-muted"
                      : wsSummary.overallUtilisationPct > 100
                      ? "text-danger"
                      : wsSummary.overallUtilisationPct >= 80
                      ? "text-warning"
                      : "text-success",
                  )}
                >
                  {wsSummary.overallUtilisationPct != null
                    ? `${wsSummary.overallUtilisationPct.toFixed(0)}%`
                    : "—"}
                </p>
              </CardBody>
            </Card>

            {/* Over-capacity members */}
            <Card>
              <CardBody className="py-4">
                <p className="text-xs text-ink-muted uppercase tracking-wide">Over capacity</p>
                <p
                  className={cn(
                    "mt-1 font-mono text-2xl font-semibold tabular-nums",
                    overAllocated > 0 ? "text-danger" : "text-ink-muted",
                  )}
                >
                  {overAllocated}
                </p>
              </CardBody>
            </Card>
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
                  No team members yet. Add your first member to track capacity and cost.
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
    </div>
  );
}
