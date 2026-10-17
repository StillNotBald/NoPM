import { cn } from "@/lib/cn";

export type PacingStatus = "over" | "behind" | "watch" | "on-track" | "no-plan";

/**
 * Pure pacing classifier: spend (burn %) should track delivery (completion %).
 * Spending ahead of delivery is the risk, so the gap is burn - expected.
 */
export function pacingStatus(burnPct: number, expectedPct: number, hasPlan: boolean): PacingStatus {
  if (!hasPlan) return "no-plan";
  if (burnPct > 100) return "over";
  const gap = burnPct - expectedPct;
  if (gap > 15) return "behind";
  if (gap > 5) return "watch";
  return "on-track";
}

const WORD: Record<PacingStatus, string> = {
  over: "Over budget",
  behind: "Overspending",
  watch: "Watch",
  "on-track": "On track",
  "no-plan": "No plan",
};
const TONE: Record<PacingStatus, string> = {
  over: "text-danger-ink",
  behind: "text-danger-ink",
  watch: "text-warning-ink",
  "on-track": "text-success-ink",
  "no-plan": "text-ink-muted",
};
const FILL: Record<PacingStatus, string> = {
  over: "bg-danger",
  behind: "bg-danger",
  watch: "bg-warning",
  "on-track": "bg-success", // status colour, not the brand blue (matches the "On track" word)
  "no-plan": "bg-ink-muted",
};

/**
 * Target-vs-actual pacing bar: fill = budget burned, tick = where spend
 * should be given delivery progress (completion %), plus a status word so
 * colour is never the only signal.
 */
export function PacingBar({
  burnPct,
  expectedPct,
  hasPlan = true,
  className,
}: {
  burnPct: number;
  expectedPct: number;
  hasPlan?: boolean;
  className?: string;
}) {
  const status = pacingStatus(burnPct, expectedPct, hasPlan);
  const fill = Math.max(0, Math.min(burnPct, 100));
  const tick = Math.max(0, Math.min(expectedPct, 100));
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <div
        className="relative h-2 min-w-[80px] flex-1 rounded-full bg-sunken print:border print:border-border-subtle"
        role="img"
        aria-label={`${burnPct.toFixed(1)}% of budget spent, ${expectedPct.toFixed(0)}% complete: ${WORD[status]}`}
      >
        <div className={cn("h-full rounded-full", FILL[status])} style={{ width: `${fill}%` }} />
        {hasPlan && (
          <div
            className="absolute top-1/2 h-4 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-ink"
            style={{ left: `${tick}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <span className="w-12 shrink-0 text-right font-mono text-xs font-medium tabular-nums text-ink-secondary">
        {burnPct.toFixed(1)}%
      </span>
      <span className={cn("w-24 shrink-0 text-xs font-medium", TONE[status])}>{WORD[status]}</span>
    </div>
  );
}
