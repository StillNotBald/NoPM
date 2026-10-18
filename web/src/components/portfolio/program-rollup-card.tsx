"use client";

import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";
import { ragLabel, ragTone, type RagStatus } from "@/lib/status";
import type { ProgramRollup } from "@/lib/insight/program-rollup";
import { useInspector } from "@/components/layout/app-shell";
import { PacingBar } from "@/components/budget/pacing-bar";
import { ProgramForm, type Program } from "@/components/forms/program-form";

export interface ProgramRollupCardProps {
  program: Program;
  /** Computed health rolled up from child projects — null with zero children. */
  computedRag: RagStatus | null;
  rollup: ProgramRollup;
}

function fmtMoney(amount: number, currency: string | null): string {
  if (currency === null) return "—";
  // Long amounts go compact (USD 4.5M); the NBSP keeps currency + number together.
  if (Math.abs(amount) >= 1_000_000) {
    const c = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(amount);
    return `${currency} ${c}`;
  }
  return `${currency} ${amount.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtHours(h: number): string {
  return Number.isInteger(h) ? String(h) : h.toFixed(1);
}

export function ProgramRollupCard({ program, computedRag, rollup }: ProgramRollupCardProps) {
  const inspector = useInspector();
  const diverges = computedRag !== null && computedRag !== program.rag_status;
  const empty = rollup.projectCount === 0;

  return (
    <div className="rounded-lg border border-border-subtle bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
        <div className="flex min-w-0 max-w-full items-center gap-2">
          {program.code && (
            <span className="font-mono text-xs text-ink-muted shrink-0">{program.code}</span>
          )}
          <span className="truncate text-sm font-semibold text-ink">{program.name}</span>
          <span className="shrink-0 text-xs text-ink-muted">
            {rollup.projectCount} project{rollup.projectCount !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="flex min-w-0 max-w-full flex-wrap items-center gap-x-4 gap-y-2">
          {/* Declared vs computed RAG, side by side (L-02) */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-ink-muted">Declared</span>
            <Badge size="sm" tone={ragTone(program.rag_status)}>
              {ragLabel(program.rag_status)}
            </Badge>
            <span className="text-ink-muted">Computed</span>
            {computedRag === null ? (
              <Badge size="sm" tone="neutral">
                —
              </Badge>
            ) : (
              <Badge size="sm" tone={ragTone(computedRag)}>
                {ragLabel(computedRag)}
              </Badge>
            )}
            {diverges && (
              <Badge size="sm" tone="warning" title="Declared health does not match the rolled-up child status">
                Diverges
              </Badge>
            )}
          </div>

          <button
            onClick={() => inspector.open(<ProgramForm mode="edit" program={program} />, "Edit Program")}
            className="text-xs font-medium text-accent hover:underline"
          >
            Edit
          </button>
        </div>
      </div>

      {empty ? (
        <div className="px-4 py-6 text-center">
          <p className="text-sm text-ink-muted">No projects in this program yet.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-4">
          {/* Completion % */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-muted">Completion</p>
            <p className="mt-0.5 font-mono text-base font-semibold text-ink tabular-nums">
              {rollup.completionPct === null ? "—" : `${rollup.completionPct}%`}
            </p>
          </div>

          {/* Budget variance */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-muted">Budget Variance</p>
            <p
              className={cn(
                "mt-0.5 whitespace-nowrap font-mono text-base font-semibold tabular-nums",
                rollup.currency === null
                  ? "text-ink-muted"
                  : rollup.budgetVariance < 0
                  ? "text-danger-ink"
                  : "text-success-ink",
              )}
            >
              {rollup.currency === null
                ? "—"
                : `${rollup.budgetVariance < 0 ? "-" : "+"}${fmtMoney(
                    Math.abs(rollup.budgetVariance),
                    rollup.currency,
                  )}`}
            </p>
          </div>

          {/* Actual vs planned cost */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-muted">Actual (expenses) / Planned</p>
            <p
              className="mt-0.5 font-mono text-base font-semibold text-ink tabular-nums"
              title={
                rollup.currency === null
                  ? undefined
                  : `${rollup.currency} ${rollup.actualAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })} / ${rollup.plannedAmount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
              }
            >
              {rollup.currency === null ? (
                "—"
              ) : (
                <>
                  <span className="whitespace-nowrap">{fmtMoney(rollup.actualAmount, rollup.currency)}</span>
                  {" / "}
                  <span className="whitespace-nowrap">{fmtMoney(rollup.plannedAmount, rollup.currency)}</span>
                </>
              )}
            </p>
            {rollup.currency !== null && (
              <PacingBar
                className="mt-1.5"
                burnPct={rollup.burnPct ?? 0}
                expectedPct={rollup.completionPct ?? 0}
                hasPlan={rollup.plannedAmount > 0}
              />
            )}
          </div>

          {/* Allocated effort vs capacity */}
          <div>
            <p className="text-[11px] uppercase tracking-wide text-ink-muted">Allocated / Capacity</p>
            <p className="mt-0.5 font-mono text-base font-semibold text-ink tabular-nums">
              {rollup.capacityHours === 0 ? (
                <span className="text-ink-muted">—</span>
              ) : (
                `${fmtHours(rollup.allocatedHours)}h / ${fmtHours(rollup.capacityHours)}h`
              )}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
