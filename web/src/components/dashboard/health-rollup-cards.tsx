"use client";

import { Card, CardBody } from "@/components/ui/card";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/cn";

type MetricCardProps = {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "neutral" | "success" | "warning" | "danger" | "info" | "accent";
  spark?: number[];
};

const toneCls: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  neutral: "text-ink",
  success: "text-success",
  warning: "text-warning",
  danger:  "text-danger",
  info:    "text-info",
  accent:  "text-accent",
};

const sparkColor: Record<NonNullable<MetricCardProps["tone"]>, string> = {
  neutral: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger:  "var(--danger)",
  info:    "var(--info)",
  accent:  "var(--accent)",
};

function MetricCard({ label, value, sub, tone = "neutral", spark }: MetricCardProps) {
  return (
    <Card>
      <CardBody className="p-5">
        <p className="text-xs font-medium uppercase tracking-widest text-ink-muted">{label}</p>
        <div className="mt-3 flex items-end justify-between gap-2">
          <div>
            <p
              className={cn(
                "font-mono text-3xl font-semibold tabular-nums leading-none tracking-tight",
                toneCls[tone],
              )}
            >
              {value}
            </p>
            {sub && (
              <p className="mt-1 text-xs text-ink-muted">{sub}</p>
            )}
          </div>
          {spark && spark.length >= 2 && (
            <div className="shrink-0 opacity-70">
              <Sparkline data={spark} width={72} height={28} color={sparkColor[tone]} />
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}

type HealthRollupProps = {
  totalProjects: number;
  greenCount: number;
  amberCount: number;
  redCount: number;
  completeCount: number;
  riskCount: number;
  issueCount: number;
  clashCount: number;
  overdueCount: number;
};

export function HealthRollupCards({
  totalProjects,
  greenCount,
  amberCount,
  redCount,
  completeCount,
  riskCount,
  issueCount,
  clashCount,
  overdueCount,
}: HealthRollupProps) {
  const overduePct =
    totalProjects > 0 ? Math.round((overdueCount / totalProjects) * 100) : 0;

  // Derive a simple "health score" % — on-track + complete / total
  const healthScore =
    totalProjects > 0
      ? Math.round(((greenCount + completeCount) / totalProjects) * 100)
      : 0;

  const healthTone =
    healthScore >= 70 ? "success" : healthScore >= 40 ? "warning" : "danger";

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <MetricCard
        label="Portfolio health"
        value={`${healthScore}%`}
        sub={`${greenCount + completeCount} of ${totalProjects} on track or complete`}
        tone={healthTone}
      />
      <MetricCard
        label="Overdue %"
        value={`${overduePct}%`}
        sub={`${overdueCount} project${overdueCount !== 1 ? "s" : ""} past target`}
        tone={overdueCount > 0 ? "danger" : "success"}
      />
      <MetricCard
        label="Open risks"
        value={riskCount}
        sub={`${issueCount} issue${issueCount !== 1 ? "s" : ""} · ${clashCount} clash${clashCount !== 1 ? "es" : ""}`}
        tone={riskCount > 0 ? "warning" : "neutral"}
      />
      <MetricCard
        label="At risk / Delayed"
        value={amberCount + redCount}
        sub={`${amberCount} amber · ${redCount} red`}
        tone={redCount > 0 ? "danger" : amberCount > 0 ? "warning" : "neutral"}
      />
    </div>
  );
}
