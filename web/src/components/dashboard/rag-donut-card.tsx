"use client";

import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { DonutChart, DonutLegend } from "@/components/charts/donut";

type RagCounts = {
  green: number;
  amber: number;
  red: number;
  complete: number;
  not_started: number;
};

const RAG_SEGMENTS = (counts: RagCounts) => [
  { label: "On track",    value: counts.green,       color: "var(--success)" },
  { label: "At risk",     value: counts.amber,        color: "var(--warning)" },
  { label: "Delayed",     value: counts.red,          color: "var(--danger)"  },
  { label: "Complete",    value: counts.complete,     color: "var(--accent)"  },
  { label: "In progress", value: counts.not_started,  color: "var(--info)"    },
];

export function RagDonutCard({ counts }: { counts: RagCounts }) {
  const segments = RAG_SEGMENTS(counts);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio Health</CardTitle>
        <span className="text-xs text-ink-muted font-mono">{total} projects</span>
      </CardHeader>
      <CardBody>
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <DonutChart segments={segments} size={120} thickness={18}>
            <div className="flex flex-col items-center">
              <span className="font-mono text-2xl font-semibold tabular-nums text-ink leading-none">
                {total}
              </span>
              <span className="mt-0.5 text-[10px] uppercase tracking-widest text-ink-muted">
                total
              </span>
            </div>
          </DonutChart>
          <div className="flex-1 min-w-0">
            <DonutLegend segments={segments} />
          </div>
        </div>
      </CardBody>
    </Card>
  );
}
