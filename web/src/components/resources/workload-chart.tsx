"use client";

import { useMemo, useState } from "react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { HorizontalBarChart } from "@/components/charts/bar";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import {
  memberPeriodUtilisation,
  fmtHours,
  type UtilisationPeriod,
} from "@/lib/resource/utilisation";

export interface WorkloadMemberInput {
  id: string;
  name: string;
  capacityHoursPerWeek: number | null;
  totalAllocationPct: number;
}

/**
 * L-13 — per-member allocated-vs-capacity bars, week/month selector changes
 * the denominator (via `memberPeriodUtilisation` in lib/resource/utilisation.ts).
 * Over-capacity members render in the tokenized danger color. A member with
 * no declared capacity can't be plotted on an hours axis at all — it's
 * listed separately as "capacity not set" rather than rendered as a 0h or
 * infinite bar. Reuses the existing HorizontalBarChart primitive — no new
 * chart dependency.
 */
export function WorkloadChart({ members }: { members: WorkloadMemberInput[] }) {
  const [period, setPeriod] = useState<UtilisationPeriod>("week");

  const { items, maxCapacity, noCapacity, overCount } = useMemo(() => {
    const withCapacity: { name: string; allocated: number; capacity: number; isOver: boolean }[] = [];
    const noCapacity: string[] = [];

    for (const m of members) {
      const stats = memberPeriodUtilisation(m.totalAllocationPct, m.capacityHoursPerWeek, period);
      if (stats.capacityHours == null || stats.allocatedHours == null) {
        noCapacity.push(m.name);
        continue;
      }
      withCapacity.push({
        name: m.name,
        allocated: stats.allocatedHours,
        capacity: stats.capacityHours,
        isOver: stats.isOver,
      });
    }

    const maxCapacity = Math.max(...withCapacity.map((m) => m.capacity), 1);
    const overCount = withCapacity.filter((m) => m.isOver).length;

    const items = withCapacity
      .sort((a, b) => b.allocated / b.capacity - a.allocated / a.capacity)
      .map((m) => ({
        label: m.name,
        value: m.allocated,
        color: m.isOver ? "var(--danger)" : "var(--accent)",
        displayValue: `${fmtHours(m.allocated)}/${fmtHours(m.capacity)}h`,
      }));

    return { items, maxCapacity, noCapacity, overCount };
  }, [members, period]);

  const periodLabel = period === "week" ? "per week" : "per month (avg.)";

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Workload</CardTitle>
          <span className="mt-0.5 block text-xs text-ink-muted">
            Allocated vs capacity, {periodLabel}
            {overCount > 0 && (
              <span className="text-danger font-medium">
                {" "}
                · {overCount} over capacity
              </span>
            )}
          </span>
        </div>
        {/* Period selector — >=44px touch targets at 390px (R-63) */}
        <div className="flex items-center rounded-md border border-border-subtle bg-canvas p-0.5 gap-0.5">
          {(["week", "month"] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              aria-pressed={period === p}
              className={cn(
                "min-h-[44px] sm:min-h-[32px] rounded px-3 text-xs font-medium capitalize transition-colors duration-150",
                period === p
                  ? "bg-accent/10 text-accent"
                  : "text-ink-muted hover:text-ink hover:bg-sunken",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardBody>
        {items.length === 0 && noCapacity.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-muted">No team members yet.</p>
        ) : (
          <div className="space-y-4">
            {items.length > 0 && (
              <HorizontalBarChart
                items={items}
                maxValue={maxCapacity}
                barHeight={14}
                gap={14}
                valueWidth={80}
              />
            )}
            {noCapacity.length > 0 && (
              <div className="flex flex-wrap items-center gap-1.5 border-t border-border-subtle pt-3">
                <span className="text-xs text-ink-muted">Capacity not set:</span>
                {noCapacity.map((name) => (
                  <Badge key={name} tone="neutral" size="sm">
                    {name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
