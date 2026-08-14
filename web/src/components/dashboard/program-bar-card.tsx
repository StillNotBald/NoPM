"use client";

import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { HorizontalBarChart } from "@/components/charts/bar";
import { CardFreshness } from "@/components/dashboard/card-freshness";

type ProgramEntry = {
  program: string | null;
  count: number;
};

export function ProgramBarCard({
  programs,
  filterLabel,
  fetchedAt,
}: {
  programs: ProgramEntry[];
  /** L-15 — active-filter note, named in the subtitle. */
  filterLabel?: string | null;
  /** L-34 — data fetch time, shown + a manual refresh button. */
  fetchedAt?: string;
}) {
  const items = programs
    .sort((a, b) => b.count - a.count)
    .slice(0, 8) // cap at 8 rows to keep the card compact
    .map((p) => ({
      label: p.program ?? "(No program)",
      value: p.count,
    }));

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>By Program</CardTitle>
          <span className="mt-0.5 block text-xs text-ink-muted font-mono truncate">
            {programs.length} programs{filterLabel ? ` · ${filterLabel}` : ""}
          </span>
        </div>
        {fetchedAt && <CardFreshness fetchedAt={fetchedAt} className="shrink-0" />}
      </CardHeader>
      <CardBody>
        {items.length === 0 ? (
          <p className="py-4 text-center text-xs text-ink-muted">
            No programs assigned yet.
          </p>
        ) : (
          <HorizontalBarChart items={items} barHeight={14} gap={12} />
        )}
      </CardBody>
    </Card>
  );
}
