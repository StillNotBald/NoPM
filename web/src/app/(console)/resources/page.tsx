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

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
        <PageHeader
          title="Resources"
          action={
            <div className="flex items-center gap-2">
              {overAllocated > 0 && (
                <Badge tone="danger" size="sm">
                  {overAllocated} over-allocated
                </Badge>
              )}
              {/* Client island — buttons open inspector forms */}
              <ResourceActions />
            </div>
          }
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
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="text-left px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Name
                    </th>
                    <th className="text-left px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Role
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Cost Rate / hr
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Cap h/wk
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Alloc h/wk
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Free h/wk
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Open Tasks
                    </th>
                    <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                      Utilisation
                    </th>
                    <th className="px-5 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {rows.map((member, idx) => {
                    const stats = memberStats[idx];
                    const { allocatedPct: pct, allocatedHours, freeHours, isOver } = stats;
                    const barWidth = Math.min(pct, 100);
                    const freeIsNegative = freeHours != null && freeHours < 0;

                    return (
                      <tr
                        key={member.id}
                        className="hover:bg-sunken transition-colors duration-100"
                      >
                        {/* Name */}
                        <td className="px-5 py-4 max-w-[180px]">
                          <span className="font-medium text-ink truncate block">
                            {member.name}
                          </span>
                        </td>

                        {/* Role */}
                        <td className="px-5 py-4 text-ink-secondary max-w-[140px]">
                          {member.role_title ? (
                            <span className="truncate block">{member.role_title}</span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Cost rate */}
                        <td className="px-5 py-4 text-right font-mono tabular-nums text-ink-secondary">
                          {fmt_currency(member.cost_rate, "USD")}
                        </td>

                        {/* Capacity h/wk */}
                        <td className="px-5 py-4 text-right font-mono tabular-nums text-ink-secondary">
                          {member.capacity_hours_per_week != null
                            ? `${fmtHours(member.capacity_hours_per_week)} h`
                            : <span className="text-ink-muted">—</span>}
                        </td>

                        {/* Allocated h/wk */}
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          {allocatedHours != null ? (
                            <span
                              className={cn(
                                "font-medium",
                                isOver ? "text-danger" : "text-ink",
                              )}
                            >
                              {fmtHours(allocatedHours)} h
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Free h/wk */}
                        <td className="px-5 py-4 text-right font-mono tabular-nums">
                          {freeHours != null ? (
                            <span
                              className={cn(
                                "font-medium",
                                freeIsNegative ? "text-danger" : freeHours === 0 ? "text-warning" : "text-success",
                              )}
                            >
                              {freeIsNegative ? "" : "+"}{fmtHours(freeHours)} h
                            </span>
                          ) : (
                            <span className="text-ink-muted">—</span>
                          )}
                        </td>

                        {/* Open tasks assigned */}
                        <td className="px-5 py-4 text-right tabular-nums">
                          {(tasksByMember[member.id] ?? 0) > 0 ? (
                            <span className="font-medium text-ink">{tasksByMember[member.id]}</span>
                          ) : (
                            <span className="text-ink-muted">0</span>
                          )}
                        </td>

                        {/* Utilisation — bar + % */}
                        <td className="px-5 py-4 text-right">
                          <div className="flex items-center justify-end gap-3">
                            {/* Mini progress bar */}
                            <div className="w-20 h-1.5 rounded-full bg-sunken overflow-hidden hidden sm:block">
                              <div
                                className={cn(
                                  "h-full rounded-full transition-all",
                                  isOver ? "bg-danger" : pct >= 80 ? "bg-warning" : "bg-accent",
                                )}
                                style={{ width: `${barWidth}%` }}
                              />
                            </div>
                            <span
                              className={cn(
                                "font-mono tabular-nums font-medium",
                                isOver
                                  ? "text-danger"
                                  : pct >= 80
                                  ? "text-warning"
                                  : "text-ink",
                              )}
                            >
                              {pct.toFixed(0)}%
                            </span>
                          </div>
                        </td>

                        {/* Over-allocated badge */}
                        <td className="px-5 py-4">
                          {isOver && <Badge tone="danger" size="sm">Over-allocated</Badge>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
