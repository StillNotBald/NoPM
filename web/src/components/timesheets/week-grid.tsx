import { Lock } from "lucide-react";
import { cn } from "@/lib/cn";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { WEEK_LOCK_REASON, type WeekLock } from "./week-lock";

/**
 * Weekly timesheet grid (L-30) — one row per distinct task/project
 * combination that has at least one entry in the selected week, columns
 * Mon–Sun. Server-rendered (no interactivity): the page re-fetches on
 * every ?member=/?week= navigation, same idiom as the sprints page's
 * ?sprint= selector.
 *
 * Built on the register table primitives (THead / TH / TD + ScrollTable) so
 * it shares the product's one table recipe and density tokens; the table
 * scrolls inside its own region and keeps the row label column sticky so a
 * row stays identifiable while scrolling through the 7 day columns.
 *
 * "0" vs "—" is deliberate (locked in the task spec): a day with a real
 * zero-hour entry (unusual but valid) renders "0"; a day with NO entry at
 * all renders "—" — a report reader must be able to tell "logged nothing"
 * apart from "logged, zero hours".
 *
 * A week whose timesheet is submitted (awaiting a decision) or approved is
 * FROZEN by the API: its time entries cannot be added or removed. `lock` says
 * so in one line above the grid; the Log time form disables itself for the same
 * weeks (see week-lock.ts).
 *
 * Mobile pass (R-94, F5): below `md` the 9-column grid (task/project + 7
 * days + total) is unreadable at phone widths even with horizontal scroll,
 * so it renders as one card per day instead — this component has no
 * inputs to begin with (hours are entered through the separate LogTimeForm
 * above it on the page, one entry at a time; this table is a read-only
 * weekly summary), so the day cards are read-only too, listing that day's
 * logged task/project rows and hours rather than fabricating inline edit
 * fields that don't exist in the desktop table either.
 */

export interface WeekGridRow {
  /** Stable key: task id when the row has one, else `project:<project_id>`. */
  key: string;
  label: string;
  /** ISO date (YYYY-MM-DD, one of the 7 week dates) -> summed hours for that day. */
  hoursByDate: Record<string, number>;
  /** Which of the 7 week dates have at least one entry (distinguishes 0 from "—"). */
  loggedDates: Set<string>;
}

function fmtHours(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Week total + capacity, with the over state spelled out (colour is never the only signal). */
function WeekTotal({ weekTotal, capacityHoursPerWeek }: { weekTotal: number; capacityHoursPerWeek: number | null }) {
  const over = capacityHoursPerWeek != null && weekTotal > capacityHoursPerWeek;
  return (
    <span className={cn("whitespace-nowrap", over ? "text-warning-ink" : "text-ink")}>
      {fmtHours(weekTotal)}
      {capacityHoursPerWeek != null && (
        <span className="ml-1 font-normal text-ink-muted">/ {fmtHours(capacityHoursPerWeek)}h cap</span>
      )}
      {over && <span className="ml-1.5 font-medium">over</span>}
    </span>
  );
}

export function WeekGrid({
  weekDates,
  rows,
  capacityHoursPerWeek,
  emptyMessage,
  lock = null,
}: {
  /** Exactly 7 ISO dates, Monday first. */
  weekDates: string[];
  rows: WeekGridRow[];
  capacityHoursPerWeek: number | null;
  emptyMessage: string;
  /**
   * Why this week is frozen, or null when it can be edited. "approved" is the
   * period-close lock (L-32/R-76); "under_review" is a submitted sheet awaiting
   * its decision (a reopened sheet is open for amendment, so it is null). The
   * grid itself has no inline edit controls — this is the reason the viewer
   * sees, and the same reason the Log time form gives when it disables itself.
   */
  lock?: WeekLock;
}) {
  const lockedCaption = lock ? (
    <p
      role="status"
      className="flex items-center gap-2 border-b border-border-subtle bg-warning/10 px-5 py-2 text-xs font-medium text-warning-ink"
    >
      <Lock size={13} aria-hidden className="shrink-0" />
      {WEEK_LOCK_REASON[lock]}
    </p>
  ) : null;

  if (rows.length === 0) {
    return (
      <>
        {lockedCaption}
        <p className="px-5 py-8 text-center text-sm text-ink-muted">{emptyMessage}</p>
      </>
    );
  }

  const columnTotals = weekDates.map((date) =>
    rows.reduce((sum, row) => sum + (row.hoursByDate[date] ?? 0), 0),
  );
  const weekTotal = columnTotals.reduce((sum, v) => sum + v, 0);

  return (
    <>
      {lockedCaption}

      {/* <md: one card per day */}
      <ul className="divide-y divide-border-subtle md:hidden">
        {weekDates.map((date, i) => {
          const dayRows = rows.filter((row) => row.loggedDates.has(date));
          const dayTotal = columnTotals[i];
          return (
            <li key={date} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm font-medium text-ink">
                  {DAY_LABELS[i]} <span className="font-mono text-xs font-normal text-ink-muted">{date.slice(5)}</span>
                </span>
                <span className="font-mono text-sm font-medium tabular-nums text-ink">{fmtHours(dayTotal)}h</span>
              </div>
              {dayRows.length === 0 ? (
                <p className="mt-1 text-xs text-ink-muted">No time logged.</p>
              ) : (
                <ul className="mt-1.5 space-y-1">
                  {dayRows.map((row) => (
                    <li key={row.key} className="flex items-baseline justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate text-ink-secondary">{row.label}</span>
                      <span className="shrink-0 font-mono tabular-nums text-ink">
                        {fmtHours(row.hoursByDate[date] ?? 0)}h
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        <li className="flex items-center justify-between gap-2 bg-sunken px-4 py-3 text-sm font-medium">
          <span className="text-ink">Week total</span>
          <span className="font-mono tabular-nums">
            <WeekTotal weekTotal={weekTotal} capacityHoursPerWeek={capacityHoursPerWeek} />
          </span>
        </li>
      </ul>

      {/* ≥md: full grid */}
      <div className="hidden md:block">
        <ScrollTable bare label="Week grid">
          <THead>
            <TR>
              <TH className="sticky left-0 z-10 bg-sunken">Task / Project</TH>
              {weekDates.map((date, i) => (
                <TH key={date} align="right">
                  <span className="block">{DAY_LABELS[i]}</span>
                  <span className="block normal-case">{date.slice(5)}</span>
                </TH>
              ))}
              <TH align="right">Total</TH>
            </TR>
          </THead>
          <tbody>
            {rows.map((row) => {
              const rowTotal = weekDates.reduce((sum, date) => sum + (row.hoursByDate[date] ?? 0), 0);
              return (
                <TR key={row.key} className="transition-colors duration-100 hover:bg-sunken">
                  <TD className="sticky left-0 z-10 bg-surface">
                    <span className="block max-w-[14rem] truncate" title={row.label}>
                      {row.label}
                    </span>
                  </TD>
                  {weekDates.map((date) => (
                    <TD key={date} align="right" numeric className="whitespace-nowrap text-ink-secondary">
                      {row.loggedDates.has(date) ? (
                        fmtHours(row.hoursByDate[date] ?? 0)
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </TD>
                  ))}
                  <TD align="right" numeric className="whitespace-nowrap font-medium">
                    {fmtHours(rowTotal)}
                  </TD>
                </TR>
              );
            })}
          </tbody>
          <tfoot>
            <TR className="border-t border-border-subtle bg-sunken font-medium">
              <TD className="sticky left-0 z-10 bg-sunken">Day total</TD>
              {columnTotals.map((total, i) => (
                <TD key={weekDates[i]} align="right" numeric className="whitespace-nowrap">
                  {fmtHours(total)}
                </TD>
              ))}
              <TD align="right" numeric>
                <WeekTotal weekTotal={weekTotal} capacityHoursPerWeek={capacityHoursPerWeek} />
              </TD>
            </TR>
          </tfoot>
        </ScrollTable>
      </div>
    </>
  );
}
