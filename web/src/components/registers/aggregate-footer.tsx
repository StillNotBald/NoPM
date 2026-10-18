"use client";

export type AggregateSpec = {
  key: string;
  label: string;
  values: Array<number | null | undefined>;
  kind: "sum" | "avg";
  format?: (n: number) => string;
};

/**
 * Per-view aggregate footer (L-16) — count + numeric column sums/averages
 * for the rows CURRENTLY on screen. Deliberately labelled "(current page)":
 * GET /api/tasks (and every register list route this reuses) returns a
 * paginated slice, not a workspace-wide total, so a footer that silently
 * implied a whole-register sum would be dishonest — the acceptance
 * criterion's own wording ("or total-scope if the API returns totals — be
 * honest in the label") is why this component never claims more than the
 * page it was actually handed.
 */
export function AggregateFooter({ count, aggregates }: { count: number; aggregates: AggregateSpec[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-b-lg border-t border-border-subtle bg-well px-3 py-2 text-sm text-ink-secondary">
      <span className="font-medium text-ink">
        {count} row{count === 1 ? "" : "s"} <span className="font-normal text-ink-muted">(current page)</span>
      </span>
      {aggregates.map((agg) => {
        const nums = agg.values.filter((v): v is number => typeof v === "number" && !Number.isNaN(v));
        if (nums.length === 0) return null;
        const total = nums.reduce((a, b) => a + b, 0);
        const value = agg.kind === "avg" ? total / nums.length : total;
        const formatted = agg.format ? agg.format(value) : String(Math.round(value * 100) / 100);
        return (
          <span key={agg.key} className="font-mono">
            {agg.label}: <span className="font-medium text-ink">{formatted}</span>
          </span>
        );
      })}
    </div>
  );
}
