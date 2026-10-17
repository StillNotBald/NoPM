"use client";

import { useMemo, type ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Severity } from "@/components/ui/severity";
import { EntityLink } from "@/components/ui/entity-link";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { RiskDetail, type RiskListRow } from "@/components/registers/risk-detail";
import { useRegisterToolbar, RegisterToolbar } from "@/components/registers/register-toolbar";
import { type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { type ColumnDef } from "@/components/registers/column-chooser";
import { type GroupByOption } from "@/components/registers/group-by-select";
import { riskScore, exposureBand } from "@/components/registers/risk-heatmap";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { cn } from "@/lib/cn";

/**
 * Risk register body: toolbar + table. The page is a server component that
 * reads Supabase directly; this client island only WRITES URL state (via
 * useRegisterToolbar) and renders the already-filtered/sorted rows the server
 * sends back. Group-by and the column chooser are purely presentational.
 */

const SEARCH_FIELD: FilterFieldConfig = { key: "q", label: "Search", type: "text", placeholder: "Risk title..." };

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "mitigating", label: "Mitigating" },
  { value: "closed", label: "Closed" },
  { value: "accepted", label: "Accepted" },
];

const SEVERITY_OPTIONS = [
  { value: "critical", label: "Critical" },
  { value: "high", label: "High" },
  { value: "medium", label: "Medium" },
  { value: "low", label: "Low" },
];

// Sortable column keys match the server/API sort whitelist field names.
const SORTABLE = new Set(["title", "severity", "status", "due_date"]);

const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "ref", label: "Ref" },
  { key: "title", label: "Title" },
  { key: "project", label: "Project" },
  { key: "severity", label: "Severity" },
  { key: "score", label: "Score" },
  { key: "strategy", label: "Strategy" },
  { key: "status", label: "Status" },
  { key: "owner", label: "Owner" },
  { key: "due_date", label: "Due" },
];

// Seven columns fit the ~974px content column at 1280 with the sidebar open;
// Score and Strategy stay one click away in the Columns chooser (the heatmap
// above already carries exposure).
const DEFAULT_COLUMNS = ["ref", "title", "project", "severity", "status", "owner", "due_date"];

const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "severity", label: "Severity" },
  { value: "status", label: "Status" },
  { value: "project", label: "Project" },
];

const STRATEGY_LABEL: Record<string, string> = {
  avoid: "Avoid",
  transfer: "Transfer",
  mitigate: "Mitigate",
  accept: "Accept",
};

function statusTone(s: string) {
  if (s === "closed" || s === "accepted") return "success" as const;
  if (s === "mitigating") return "warning" as const;
  if (s === "open") return "info" as const;
  return "neutral" as const;
}

function strategyTone(s: string) {
  if (s === "avoid") return "danger" as const;
  if (s === "transfer") return "info" as const;
  if (s === "mitigate") return "warning" as const;
  return "success" as const;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

export function RiskRegister({
  risks,
  projects,
  projectMap,
  ownerMap,
  dateDisplayPref,
  canWrite,
  emptyAction,
}: {
  risks: RiskListRow[];
  projects: Array<{ id: string; name: string }>;
  projectMap: Record<string, string>;
  ownerMap: Record<string, string>;
  dateDisplayPref: DateDisplayPref;
  canWrite: boolean;
  emptyAction?: ReactNode;
}) {
  const inspector = useInspector();

  const sheetFields = useMemo<readonly FilterFieldConfig[]>(
    () => [
      { key: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      { key: "severity", label: "Severity", type: "select", options: SEVERITY_OPTIONS },
      {
        key: "project_id",
        label: "Project",
        type: "select",
        options: projects.map((p) => ({ value: p.id, label: p.name })),
      },
    ],
    [projects],
  );

  const controls = useRegisterToolbar({
    register: "risks",
    exportEntity: "risks",
    searchField: SEARCH_FIELD,
    sheetFields,
    columns: ALL_COLUMNS,
    defaultColumns: DEFAULT_COLUMNS,
    groupByOptions: GROUP_BY_OPTIONS,
  });
  const { sort, visibleColumns, groupBy, toggleSort, activeFilterCount, clearFilters } = controls;

  function ownerName(id: string | null | undefined) {
    if (!id) return "-";
    return ownerMap[id] ?? id.slice(0, 8) + "...";
  }

  function openRisk(r: RiskListRow) {
    inspector.open(
      <RiskDetail
        risk={r}
        projectName={r.project_id ? projectMap[r.project_id] : undefined}
        ownerName={ownerName(r.owner_id)}
        dateDisplayPref={dateDisplayPref}
      />,
      r.reference_id ? `Risk ${r.reference_id}` : "Risk Detail",
    );
  }

  function cell(key: string, r: RiskListRow): ReactNode {
    switch (key) {
      case "ref":
        return r.reference_id ? (
          <span className="whitespace-nowrap rounded border border-border-subtle bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-muted">
            {r.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">-</span>
        );
      case "title":
        return (
          <button
            type="button"
            onClick={() => openRisk(r)}
            title={r.title}
            className="focus-ring block max-w-[15rem] truncate rounded text-left font-medium text-ink hover:text-accent"
          >
            {r.title}
          </button>
        );
      case "project":
        return r.project_id ? (
          <span className="block min-w-0 max-w-[9.5rem]">
            <EntityLink kind="project" id={r.project_id} muted>
              {projectMap[r.project_id] ?? "-"}
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">-</span>
        );
      case "severity":
        return <Severity level={r.severity} />;
      case "score": {
        const score = riskScore(r.probability_pct ?? null, r.impact_score ?? null);
        const band = exposureBand(score);
        return score != null && band ? (
          <span className="inline-flex items-center gap-2 whitespace-nowrap">
            <Severity level={band} />
            <span className="font-mono text-xs tabular-nums text-ink-muted">{score}/5</span>
          </span>
        ) : (
          <span className="text-ink-muted">-</span>
        );
      }
      case "strategy":
        return r.response_strategy ? (
          <Badge size="sm" tone={strategyTone(r.response_strategy)}>
            {STRATEGY_LABEL[r.response_strategy] ?? r.response_strategy}
          </Badge>
        ) : (
          <span className="text-ink-muted">-</span>
        );
      case "status":
        return (
          <Badge size="sm" tone={statusTone(r.status)}>
            {r.status}
          </Badge>
        );
      case "owner":
        return <span className="whitespace-nowrap text-xs text-ink-secondary">{ownerName(r.owner_id)}</span>;
      case "due_date": {
        const due = formatByPref(r.due_date, dateDisplayPref);
        return (
          <span className="whitespace-nowrap text-xs tabular-nums text-ink-secondary" title={due.title}>
            {due.text}
          </span>
        );
      }
      default:
        return null;
    }
  }

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: "__all__", label: "", rows: risks }];
    const map = new Map<string, { key: string; label: string; rows: RiskListRow[] }>();
    for (const r of risks) {
      let key: string;
      let label: string;
      if (groupBy === "project") {
        key = r.project_id ?? "__none__";
        label = r.project_id ? (projectMap[r.project_id] ?? "Unknown project") : "No project";
      } else {
        key = groupBy === "severity" ? r.severity : r.status;
        label = key;
      }
      if (!map.has(key)) map.set(key, { key, label, rows: [] });
      map.get(key)!.rows.push(r);
    }
    const list = [...map.values()];
    if (groupBy === "severity") {
      list.sort((a, b) => SEVERITY_ORDER.indexOf(a.key) - SEVERITY_ORDER.indexOf(b.key));
    }
    return list;
  }, [risks, groupBy, projectMap]);

  const mobileColumns: DataListColumn<RiskListRow>[] = [
    { key: "title", header: "Title", primary: true, cell: (r) => <span className="font-medium text-ink">{r.title}</span> },
    // Two heat dots on one card need words, or "Low" and "Medium 2/5" read as contradictions.
    {
      key: "severity",
      header: "Severity",
      badge: true,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-xs text-ink-muted">Severity</span>
          {cell("severity", r)}
        </span>
      ),
    },
    {
      key: "score",
      header: "Score",
      badge: true,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="text-xs text-ink-muted">Score</span>
          {cell("score", r)}
        </span>
      ),
    },
    { key: "status", header: "Status", badge: true, cell: (r) => cell("status", r) },
    { key: "owner", header: "Owner", cell: (r) => cell("owner", r) },
    { key: "due_date", header: "Due", cell: (r) => cell("due_date", r) },
  ];

  return (
    <div className="space-y-4">
      <RegisterToolbar controls={controls} />

      {risks.length === 0 ? (
        activeFilterCount > 0 ? (
          <EmptyState
            purpose={`No risks match the ${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""}.`}
            canWrite
            action={
              <Button variant="secondary" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            purpose="The risk register tracks anything that could derail a project before it happens: probability, impact, and a mitigation owner."
            canWrite={canWrite}
            action={emptyAction}
            docsHref="/trust"
            docsLabel="See governance in the Trust Center"
          />
        )
      ) : (
        <>
          <div className="hidden md:block">
            <ScrollTable label="Risk register">
              <THead>
                <TR>
                  {visibleColumns.map((col) => {
                    const sortable = SORTABLE.has(col.key);
                    const active = sort?.field === col.key;
                    return (
                      <TH
                        key={col.key}
                        aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : undefined}
                      >
                        {sortable ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(col.key)}
                            aria-label={`Sort by ${col.label}`}
                            className={cn(
                              "focus-ring inline-flex items-center gap-1 rounded uppercase hover:text-ink",
                              active && "text-ink",
                            )}
                          >
                            {col.label}
                            {active &&
                              (sort!.direction === "asc" ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              ))}
                          </button>
                        ) : (
                          col.label
                        )}
                      </TH>
                    );
                  })}
                </TR>
              </THead>
              <tbody>
                {groups.map((g) => (
                  <GroupRows key={g.key} label={g.label} count={g.rows.length} span={visibleColumns.length}>
                    {g.rows.map((r) => (
                      <TR key={r.id} className="hover:bg-sunken">
                        {visibleColumns.map((col) => (
                          <TD key={col.key} className="whitespace-nowrap">
                            {cell(col.key, r)}
                          </TD>
                        ))}
                      </TR>
                    ))}
                  </GroupRows>
                ))}
              </tbody>
            </ScrollTable>
            <p className="mt-2 text-xs text-ink-muted">
              {risks.length} risk{risks.length === 1 ? "" : "s"}
            </p>
          </div>

          <div className="rounded-lg border border-border-subtle md:hidden">
            <DataList columns={mobileColumns} rows={risks} rowKey={(r) => r.id} onRowClick={openRisk} />
          </div>
        </>
      )}
    </div>
  );
}

function GroupRows({
  label,
  count,
  span,
  children,
}: {
  label: string;
  count: number;
  span: number;
  children: ReactNode;
}) {
  return (
    <>
      {label !== "" && (
        <TR className="bg-sunken/60">
          <TD colSpan={span} className="text-xs font-medium uppercase tracking-wide text-ink-muted">
            {label} / {count}
          </TD>
        </TR>
      )}
      {children}
    </>
  );
}
