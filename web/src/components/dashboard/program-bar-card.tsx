"use client";

import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { HorizontalBarChart } from "@/components/charts/bar";
import { CardFreshness } from "@/components/dashboard/card-freshness";

type ProgramEntry = {
  program: string | null;
  count: number;
  /** BAC-independent rollup completion (computeProgramRollup); null when empty. */
  completionPct?: number | null;
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
  const items = [...programs]
    .sort((a, b) => b.count - a.count)
    .slice(0, 8) // cap at 8 rows to keep the card compact
    .map((p) => ({
      label: p.program ?? "(No program)",
      value: p.count,
      completionPct: p.completionPct ?? null,
    }));

  return (
    <Card>
      <CardHeader>
        <div className="min-w-0">
          <CardTitle>By Program</CardTitle>
          <span className="mt-0.5 block text-xs text-ink-muted font-mono truncate">
            {programs.length} program{programs.length === 1 ? "" : "s"}{filterLabel ? ` · ${filterLabel}` : ""}
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
          <>
            <HorizontalBarChart items={items.map(({ label, value }) => ({ label, value }))} barHeight={14} gap={12} />
            {/* Text alternative: the bars encode count only; this adds the
                exact numbers + rollup completion for screen readers. */}
            <div className="sr-only"><table>
              <caption>Projects by program</caption>
              <thead>
                <tr>
                  <th scope="col">Program</th>
                  <th scope="col">Projects</th>
                  <th scope="col">Average completion</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.label}>
                    <th scope="row">{i.label}</th>
                    <td>{i.value}</td>
                    <td>{i.completionPct == null ? "n/a" : `${Math.round(i.completionPct)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </>
        )}
      </CardBody>
    </Card>
  );
}
