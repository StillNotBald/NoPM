import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/page-header";
import { cn } from "@/lib/cn";

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
  const sym = currency ?? "MYR";
  return `${sym} ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  let allocationsByMember: Record<string, number> = {};

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

  const totalMembers = rows.length;
  const overAllocated = rows.filter(
    (m) => (allocationsByMember[m.id] ?? 0) > 100,
  ).length;

  return (
    <div className="px-4 py-5 sm:px-6 sm:py-6 lg:px-8 space-y-6">
      <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader
        title="Resources"
        action={overAllocated > 0 ? <Badge tone="danger">{overAllocated} over-allocated</Badge> : undefined}
      />

      {/* Summary cards */}
      {rows.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3">
          <Card>
            <CardBody className="py-4">
              <p className="text-xs text-ink-muted uppercase tracking-wide">Total Members</p>
              <p className="mt-1 text-2xl font-semibold text-ink">{totalMembers}</p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-4">
              <p className="text-xs text-ink-muted uppercase tracking-wide">Available</p>
              <p className="mt-1 text-2xl font-semibold text-success">
                {rows.filter((m) => (allocationsByMember[m.id] ?? 0) <= 100).length}
              </p>
            </CardBody>
          </Card>
          <Card>
            <CardBody className="py-4">
              <p className="text-xs text-ink-muted uppercase tracking-wide">Over-allocated</p>
              <p className={cn("mt-1 text-2xl font-semibold", overAllocated > 0 ? "text-danger" : "text-ink-muted")}>
                {overAllocated}
              </p>
            </CardBody>
          </Card>
        </div>
      )}

      {/* Members table */}
      <Card>
        <CardHeader>
          <CardTitle>Team Members</CardTitle>
        </CardHeader>
        {rows.length === 0 ? (
          <CardBody>
            <p className="text-sm text-ink-muted text-center py-6">
              No resource members found. Add members to get started.
            </p>
          </CardBody>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
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
                    Capacity (h/wk)
                  </th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Allocated %
                  </th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rows.map((member) => {
                  const pct = allocationsByMember[member.id] ?? 0;
                  const isOver = pct > 100;
                  const barWidth = Math.min(pct, 100);

                  return (
                    <tr
                      key={member.id}
                      className="hover:bg-sunken transition-colors duration-100"
                    >
                      {/* Name */}
                      <td className="px-5 py-4">
                        <span className="font-medium text-ink">{member.name}</span>
                      </td>

                      {/* Role */}
                      <td className="px-5 py-4 text-ink-secondary">
                        {member.role_title ?? <span className="text-ink-muted">—</span>}
                      </td>

                      {/* Cost rate */}
                      <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">
                        {fmt_currency(member.cost_rate, "MYR")}
                      </td>

                      {/* Capacity */}
                      <td className="px-5 py-4 text-right tabular-nums text-ink-secondary">
                        {member.capacity_hours_per_week != null
                          ? `${member.capacity_hours_per_week} h`
                          : <span className="text-ink-muted">—</span>}
                      </td>

                      {/* Allocated % — bar + number */}
                      <td className="px-5 py-4 text-right">
                        <div className="flex items-center justify-end gap-3">
                          {/* Mini progress bar */}
                          <div className="w-24 h-1.5 rounded-full bg-sunken overflow-hidden hidden sm:block">
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
                              "tabular-nums font-medium",
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
                        {isOver && (
                          <Badge tone="danger">Over-allocated</Badge>
                        )}
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
