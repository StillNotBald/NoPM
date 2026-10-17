import { cn } from "@/lib/cn";

/**
 * Weekly timesheet grid (L-30) — one row per distinct task/project
 * combination that has at least one entry in the selected week, columns
 * Mon–Sun. Server-rendered (no interactivity): the page re-fetches on
 * every ?member=/?week= navigation, same idiom as the sprints page's
 * ?sprint= selector.
 *
 * R-63 table idiom: overflow-x-auto + min-w wrapper, sticky first column
 * (the row label needs to stay visible while scrolling through 7 day
 * columns on narrow viewports), exact `px-5 py-3` cell pair to inherit the
 * .density-compact coupling (globals.css:175-225).
 *
 * "0" vs "—" is deliberate (locked in the task spec): a day with a real
 * zero-hour entry (unusual but valid) renders "0"; a day with NO entry at
 * all renders "—" — a report reader must be able to tell "logged nothing"
 * apart from "logged, zero hours".
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

export function WeekGrid({
  weekDates,
  rows,
  capacityHoursPerWeek,
  emptyMessage,
  locked = false,
}: {
  /** Exactly 7 ISO dates, Monday first. */
  weekDates: string[];
  rows: WeekGridRow[];
  capacityHoursPerWeek: number | null;
  emptyMessage: string;
  /**
   * L-32/R-76: true when this week has an APPROVED timesheet_submission —
   * time entries in it reject create/delete (route guard + DB backstop
   * trigger, migration 20260815000040) until the submission is reopened.
   * Purely informational here (the grid has no inline edit/delete controls
   * to disable) — the caption below just tells the viewer WHY a write would
   * fail if they tried one elsewhere (e.g. the Log time form).
   */
  locked?: boolean;
}) {
  const lockedCaption = locked ? (
    <p className="border-b border-border-subtle bg-warning-subtle px-5 py-2 text-xs font-medium text-warning-ink">
      Week approved — locked. Time entries in this week can&apos;t be added or removed until the submission is reopened.
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
          <span
            className={cn(
              "font-mono tabular-nums",
              capacityHoursPerWeek != null && weekTotal > capacityHoursPerWeek ? "text-warning-ink" : "text-ink",
            )}
          >
            {fmtHours(weekTotal)}
            {capacityHoursPerWeek != null && (
              <span className="ml-1 font-normal text-ink-muted">/ {fmtHours(capacityHoursPerWeek)}h cap</span>
            )}
          </span>
        </li>
      </ul>

      {/* ≥md: full grid */}
      <div className="hidden overflow-x-auto md:block">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="border-b border-border-subtle bg-sunken text-left">
            <th className="sticky left-0 z-10 bg-sunken px-5 py-3 text-xs font-medium text-ink-muted uppercase tracking-wide">
              Task / Project
            </th>
            {weekDates.map((date, i) => (
              <th
                key={date}
                className="px-5 py-3 text-right text-xs font-medium text-ink-muted uppercase tracking-wide"
              >
                <span className="block">{DAY_LABELS[i]}</span>
                <span className="block font-mono text-xs normal-case text-ink-muted/80">
                  {date.slice(5)}
                </span>
              </th>
            ))}
            <th className="px-5 py-3 text-right text-xs font-medium text-ink-muted uppercase tracking-wide">
              Total
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row) => {
            const rowTotal = weekDates.reduce((sum, date) => sum + (row.hoursByDate[date] ?? 0), 0);
            return (
              <tr key={row.key} className="hover:bg-sunken transition-colors duration-100">
                <td className="sticky left-0 z-10 bg-surface px-5 py-3 max-w-[220px] truncate text-ink">
                  {row.label}
                </td>
                {weekDates.map((date) => (
                  <td key={date} className="px-5 py-3 text-right font-mono tabular-nums text-ink-secondary">
                    {row.loggedDates.has(date) ? fmtHours(row.hoursByDate[date] ?? 0) : (
                      <span className="text-ink-muted">—</span>
                    )}
                  </td>
                ))}
                <td className="px-5 py-3 text-right font-mono font-medium tabular-nums text-ink">
                  {fmtHours(rowTotal)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-subtle bg-sunken font-medium">
            <td className="sticky left-0 z-10 bg-sunken px-5 py-3 text-ink">Day total</td>
            {columnTotals.map((total, i) => (
              <td key={weekDates[i]} className="px-5 py-3 text-right font-mono tabular-nums text-ink">
                {fmtHours(total)}
              </td>
            ))}
            <td
              className={cn(
                "px-5 py-3 text-right font-mono tabular-nums",
                capacityHoursPerWeek != null && weekTotal > capacityHoursPerWeek ? "text-warning-ink" : "text-ink",
              )}
            >
              {fmtHours(weekTotal)}
              {capacityHoursPerWeek != null && (
                <span className="ml-1 font-normal text-ink-muted">/ {fmtHours(capacityHoursPerWeek)}h cap</span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
    </>
  );
}
