"use client";

import { useEffect, useMemo, useState } from "react";
import { FilterBar } from "@/components/registers/filter-bar";
import {
  useListControls,
  toApiQueryString,
  type FilterFieldConfig,
} from "@/components/registers/use-list-controls";
import { ExportCsvButton } from "@/components/export-csv-button";
import { Spinner } from "@/components/ui/spinner";
import { apiGet } from "@/lib/api-client";
import { aggregateTimeReport, type TimeEntryForReport } from "@/lib/insight/time-report";

/**
 * Time report section (L-28) — filterable rollup over GET /api/time-entries
 * (member/project/date-range/billable, reusing the FilterBar/useListControls
 * pattern the task register established) with totals computed by the pure
 * lib/insight/time-report.ts. Own filter param keys (member_id/project_id/
 * date_from/date_to/billable) are namespaced away from the week grid's
 * ?member=/?week= params above it on the same page — the two sections
 * navigate independently.
 *
 * Like AggregateFooter, totals are honestly labelled "(current page)" — this
 * is a rollup over the fetched page of entries, not a workspace-wide sum
 * the API doesn't return.
 */

// Large enough that typical filtered ranges (a project-month, a member's
// quarter) fit in one page; still bounded so the report can't hang the tab.
const REPORT_PAGE_SIZE = 500;

interface TimeEntryRow extends TimeEntryForReport {
  entry_date: string;
}

interface NamedOption {
  id: string;
  name: string;
}

export function ReportFilters() {
  const [members, setMembers] = useState<NamedOption[]>([]);
  const [projects, setProjects] = useState<NamedOption[]>([]);

  useEffect(() => {
    apiGet<NamedOption[]>("/api/resources?limit=100")
      .then((list) => setMembers(list ?? []))
      .catch(() => {});
    apiGet<NamedOption[]>("/api/projects?limit=100")
      .then((list) => setProjects(list ?? []))
      .catch(() => {});
  }, []);

  const FILTER_FIELDS: readonly FilterFieldConfig[] = useMemo(
    () => [
      {
        key: "member_id",
        label: "Member",
        type: "select",
        options: members.map((m) => ({ value: m.id, label: m.name })),
      },
      {
        key: "project_id",
        label: "Project",
        type: "select",
        options: projects.map((p) => ({ value: p.id, label: p.name })),
      },
      { key: "date", label: "Date", type: "date-range", fromKey: "date_from", toKey: "date_to" },
      {
        key: "billable",
        label: "Billable",
        type: "select",
        options: [
          { value: "true", label: "Billable only" },
          { value: "false", label: "Non-billable only" },
        ],
      },
    ],
    [members, projects],
  );

  const { filters, activeFilterCount, setFilter, clearFilters } = useListControls(FILTER_FIELDS);

  const apiQuery = useMemo(
    () => toApiQueryString(filters, null, 1, { limit: String(REPORT_PAGE_SIZE) }),
    [filters],
  );

  // Loading/error are derived from whether the last fetched result matches the
  // current query — avoids synchronous setState inside the effect
  // (react-hooks/set-state-in-effect) while keeping stale rows visible during a
  // refetch, same UX as before.
  const [result, setResult] = useState<{
    query: string;
    rows: TimeEntryRow[];
    total: number;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/time-entries?${apiQuery}`)
      .then(async (res) => {
        const json = (await res.json().catch(() => ({}))) as {
          data?: TimeEntryRow[];
          total?: number;
          error?: string;
        };
        if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
        if (cancelled) return;
        setResult({ query: apiQuery, rows: json.data ?? [], total: json.total ?? 0, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setResult({ query: apiQuery, rows: [], total: 0, error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [apiQuery]);

  const loading = result === null || result.query !== apiQuery;
  const rows = useMemo(() => result?.rows ?? [], [result]);
  const total = result?.total ?? 0;
  const error = !loading ? (result?.error ?? null) : null;

  const report = useMemo(() => aggregateTimeReport(rows), [rows]);

  const memberNameById = useMemo(() => new Map(members.map((m) => [m.id, m.name])), [members]);
  const projectNameById = useMemo(() => new Map(projects.map((p) => [p.id, p.name])), [projects]);

  const billableFilterActive = filters.billable === "true" || filters.billable === "false";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <FilterBar
          fields={FILTER_FIELDS}
          values={filters}
          onChange={setFilter}
          onClear={clearFilters}
          activeCount={activeFilterCount}
        />
        <ExportCsvButton href={`/api/export?entity=time_entries&${apiQuery}`} />
      </div>

      {error && (
        <div className="rounded-lg border border-danger/30 bg-danger/15 px-4 py-3 text-sm text-danger-ink">
          Failed to load time entries: {error}
        </div>
      )}

      {loading && (
        <div className="flex items-center gap-2 py-8 justify-center text-sm text-ink-muted">
          <Spinner size="sm" /> Loading report…
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <p className="px-1 py-6 text-sm text-ink-muted">
          {activeFilterCount > 0
            ? `No time entries match the ${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""}.`
            : "No time has been logged yet."}
        </p>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <TotalCard label="Total hours" value={`${report.totalHours}h`} />
            <TotalCard label="Billable" value={`${report.billableHours}h`} />
            <TotalCard label="Non-billable" value={`${report.nonBillableHours}h`} />
            <TotalCard label="Total cost" value={report.totalCost.toLocaleString("en-US", { style: "currency", currency: "USD" })} />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ReportTable
              title="By member"
              rows={report.byMember.map((m) => ({
                key: m.member_id,
                label: memberNameById.get(m.member_id) ?? "Unknown member",
                hours: m.hours,
                cost: m.cost,
              }))}
            />
            <ReportTable
              title="By project"
              rows={report.byProject.map((p) => ({
                key: p.project_id,
                label: projectNameById.get(p.project_id) ?? "Unknown project",
                hours: p.hours,
                cost: p.cost,
              }))}
            />
          </div>

          <p className="text-xs text-ink-muted">
            {report.entryCount} entr{report.entryCount === 1 ? "y" : "ies"}{" "}
            <span className="text-ink-muted/80">(current page{total > rows.length ? `, ${total} total match` : ""})</span>
            {" — "}
            {billableFilterActive
              ? "the billable filter is on, so this total legitimately diverges from /budget's labour actual."
              : "these totals include non-billable time and exclude expenses — they match /budget's labour actual (Σ time_entries.cost) when no billable filter is applied."}{" "}
            Cost is always the entry&apos;s cost snapshot at the time it was logged, never a member&apos;s current rate.
          </p>
        </div>
      )}
    </div>
  );
}

function TotalCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface px-4 py-3">
      <p className="text-xs text-ink-muted uppercase tracking-wide">{label}</p>
      <p className="mt-1 font-mono text-xl font-semibold text-ink tabular-nums">{value}</p>
    </div>
  );
}

interface ReportRow {
  key: string;
  label: string;
  hours: number;
  cost: number;
}

/**
 * Mobile pass (R-94, F5) — the bare (no-header) `<table>` this used to
 * always render clipped its label column hard at phone widths. Below `md`
 * it's now one row-card per member/project (label + hours/cost stacked to
 * the right); the `≥md` branch keeps the exact original table markup
 * unchanged so desktop is pixel-identical to before. Kept as a small
 * hand-rolled split rather than DataList — DataList always renders a
 * `<thead>`, and this table deliberately has none (the section title bar
 * above it stands in for a header); reusing it would add a header row on
 * desktop that wasn't there before.
 */
function ReportTable({ title, rows }: { title: string; rows: ReportRow[] }) {
  return (
    <div className="rounded-lg border border-border-subtle">
      <div className="border-b border-border-subtle px-4 py-2.5 text-sm font-medium text-ink">{title}</div>
      {rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-muted">No rows.</p>
      ) : (
        <>
          {/* <md: cards */}
          <ul className="divide-y divide-border-subtle md:hidden">
            {rows.map((r) => (
              <li key={r.key} className="flex min-h-[44px] items-center justify-between gap-3 px-4 py-2.5">
                <span className="min-w-0 truncate text-sm text-ink">{r.label}</span>
                <span className="shrink-0 text-right">
                  <span className="block font-mono text-xs tabular-nums text-ink-secondary">{r.hours}h</span>
                  <span className="block font-mono text-2xs tabular-nums text-ink-muted">
                    {r.cost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                  </span>
                </span>
              </li>
            ))}
          </ul>

          {/* ≥md: original table, unchanged */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-border-subtle">
                {rows.map((r) => (
                  <tr key={r.key}>
                    <td className="px-4 py-2 text-ink truncate max-w-[180px]">{r.label}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-secondary">{r.hours}h</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums text-ink-secondary">
                      {r.cost.toLocaleString("en-US", { style: "currency", currency: "USD" })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
