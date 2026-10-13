/**
 * KpiTile: label + value (+ optional delta and inline sparkline).
 *
 *   <KpiTile label="Budget burn" value="62%"
 *            delta={{ value: 4, unit: "pts", goodWhen: "down" }}
 *            comparison="vs last period" spark={[3, 4, 4, 6, 5, 7]} />
 *
 * Delta shows an arrow AND sr-only text ("up"/"down"), so colour is never
 * the only signal. Whether "up" is good depends on the metric, hence
 * `goodWhen` (default "up"; "neutral" = no judgement). The sparkline reuses
 * the hand-rolled SVG in components/charts/sparkline (no chart lib).
 * Not yet adopted by pages.
 */
import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/cn";

export interface KpiDelta {
  /** Signed change; the sign decides direction. */
  value: number;
  /** Unit text shown after the number, e.g. "%", "pts", "d". */
  unit?: string;
  /** Which direction is favourable. Default "up". */
  goodWhen?: "up" | "down" | "neutral";
}

export function KpiTile({
  label,
  value,
  sub,
  delta,
  comparison,
  spark,
  className,
}: {
  label: string;
  value: string | number;
  /** Optional line under the value. */
  sub?: string;
  delta?: KpiDelta;
  /** Text after the delta, e.g. "vs previous period". */
  comparison?: string;
  /** Series for a tiny trend line (needs >= 2 points). */
  spark?: number[];
  className?: string;
}) {
  let deltaEl: ReactNode = null;
  if (delta) {
    const dir = delta.value > 0 ? "up" : delta.value < 0 ? "down" : "flat";
    const good = delta.goodWhen ?? "up";
    const tone =
      dir === "flat" || good === "neutral"
        ? "text-ink-secondary"
        : dir === good
          ? "text-success-ink"
          : "text-danger-ink";
    const Icon = dir === "up" ? ArrowUpRight : dir === "down" ? ArrowDownRight : Minus;
    const unit = delta.unit === "%" ? "%" : delta.unit ? ` ${delta.unit}` : "";
    deltaEl = (
      <p className={cn("mt-1 flex items-center gap-1 text-xs", tone)}>
        <Icon size={14} aria-hidden="true" />
        <span className="font-mono tabular-nums">
          {Math.abs(delta.value)}
          {unit}
          <span className="sr-only">{dir === "flat" ? " no change" : ` ${dir}`}</span>
        </span>
        {comparison && <span className="text-ink-muted">{comparison}</span>}
      </p>
    );
  }
  return (
    <div className={cn("rounded-lg border border-border-subtle bg-surface px-4 py-3.5", className)}>
      <p className="font-mono text-2xs font-medium uppercase tracking-wider text-ink-muted">{label}</p>
      <div className="mt-1 flex items-end justify-between gap-3">
        <p className="font-mono text-2xl font-semibold tabular-nums text-ink">{value}</p>
        {spark && spark.length >= 2 && (
          <span aria-hidden="true" className="shrink-0">
            <Sparkline data={spark} width={72} height={24} />
          </span>
        )}
      </div>
      {deltaEl}
      {sub && <p className="mt-1 text-xs text-ink-secondary">{sub}</p>}
    </div>
  );
}
