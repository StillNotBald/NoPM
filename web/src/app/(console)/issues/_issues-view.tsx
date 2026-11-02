"use client";

import { Fragment, useMemo } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Severity } from "@/components/ui/severity";
import { Button } from "@/components/ui/button";
import { EntityLink } from "@/components/ui/entity-link";
import { EmptyState } from "@/components/ui/empty-state";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import { NewIssueButton } from "@/components/registers/new-issue-form";
import { IssueDataList, IssueDetail, type IssueDetailProps } from "@/components/registers/issue-detail";
import { type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { useRegisterToolbar, RegisterToolbar } from "@/components/registers/register-toolbar";
import { type GroupByOption } from "@/components/registers/group-by-select";
import { type ColumnDef } from "@/components/registers/column-chooser";
import { useInspector } from "@/components/layout/app-shell";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { cn } from "@/lib/cn";

export type IssueRow = IssueDetailProps["issue"];

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
];
const SEVERITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "critical", label: "Critical" },
];
const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const SEARCH_FIELD: FilterFieldConfig = { key: "q", label: "Search", type: "text", placeholder: "Issue title…" };

const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "reference_id", label: "Ref" },
  { key: "title", label: "Title" },
  { key: "project_id", label: "Project" },
  { key: "priority", label: "Priority" },
  { key: "severity", label: "Severity" },
  { key: "status", label: "Status" },
  { key: "due_date", label: "Due" },
];
const DEFAULT_COLUMNS = ["reference_id", "title", "project_id", "priority", "status", "due_date"];
const SORTABLE = new Set(["title", "priority", "severity", "status", "due_date"]);

const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "status", label: "Status" },
  { value: "severity", label: "Severity" },
  { value: "priority", label: "Priority" },
  { value: "project", label: "Project" },
];

function statusTone(s: string) {
  if (s === "resolved" || s === "closed") return "success" as const;
  if (s === "in_progress") return "info" as const;
  if (s === "open") return "warning" as const;
  return "neutral" as const;
}
function statusLabel(s: string) {
  if (s === "in_progress") return "In progress";
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function IssuesView({
  issues,
  projects,
  projectMap,
  dateDisplayPref,
  canWrite,
}: {
  issues: IssueRow[];
  projects: { id: string; name: string }[];
  projectMap: Record<string, string>;
  dateDisplayPref: DateDisplayPref;
  canWrite: boolean;
}) {
  const inspector = useInspector();
  const sheetFields = useMemo<readonly FilterFieldConfig[]>(
    () => [
      { key: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      { key: "severity", label: "Severity", type: "select", options: SEVERITY_OPTIONS },
      { key: "priority", label: "Priority", type: "select", options: PRIORITY_OPTIONS },
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
    register: "issues",
    exportEntity: "issues",
    searchField: SEARCH_FIELD,
    sheetFields,
    columns: ALL_COLUMNS,
    defaultColumns: DEFAULT_COLUMNS,
    groupByOptions: GROUP_BY_OPTIONS,
    pageSize: 1000,
  });
  const { sort, toggleSort, visibleColumns, groupBy, activeFilterCount, clearFilters } = controls;

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: "__all__", label: "", rows: issues }];
    const order: string[] = [];
    const buckets = new Map<string, { key: string; label: string; rows: IssueRow[] }>();
    for (const row of issues) {
      let key: string;
      let label: string;
      if (groupBy === "project") {
        key = row.project_id ?? "__none__";
        label = row.project_id ? (projectMap[row.project_id] ?? "Unknown project") : "No project";
      } else if (groupBy === "status") {
        key = row.status;
        label = statusLabel(row.status);
      } else {
        const v = (groupBy === "severity" ? row.severity : row.priority) ?? "";
        key = v || "__none__";
        label = v ? cap(v) : `No ${groupBy}`;
      }
      if (!buckets.has(key)) {
        buckets.set(key, { key, label, rows: [] });
        order.push(key);
      }
      buckets.get(key)!.rows.push(row);
    }
    return order.map((k) => buckets.get(k)!);
  }, [issues, groupBy, projectMap]);

  function openIssue(issue: IssueRow) {
    inspector.open(
      <IssueDetail
        issue={issue}
        projectName={issue.project_id ? (projectMap[issue.project_id] ?? undefined) : undefined}
        dateDisplayPref={dateDisplayPref}
      />,
      issue.reference_id ? `Issue ${issue.reference_id}` : "Issue Detail",
    );
  }

  function cell(key: string, i: IssueRow) {
    switch (key) {
      case "reference_id":
        return i.reference_id ? (
          <span className="whitespace-nowrap rounded border border-border-subtle bg-well px-1.5 py-0.5 font-mono text-xs text-ink-muted">
            {i.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      case "title":
        // A real button: the row's own click is a mouse convenience, this is the
        // keyboard / screen-reader way to open the inspector.
        return (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openIssue(i);
            }}
            title={i.title}
            className="focus-ring block min-w-0 max-w-[15rem] truncate rounded text-left font-medium text-ink hover:text-accent"
          >
            {i.title}
          </button>
        );
      case "project_id":
        return i.project_id ? (
          <span className="block min-w-0 max-w-[11rem]" onClick={(e) => e.stopPropagation()}>
            <EntityLink kind="project" id={i.project_id} muted>
              {projectMap[i.project_id] ?? "—"}
            </EntityLink>
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      case "priority":
        return <Severity level={i.priority} />;
      case "severity":
        return i.severity ? <Severity level={i.severity} /> : <span className="text-ink-muted">—</span>;
      case "status":
        return (
          <Badge size="sm" tone={statusTone(i.status)}>
            {statusLabel(i.status)}
          </Badge>
        );
      case "due_date": {
        const due = formatByPref(i.due_date, dateDisplayPref);
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

  return (
    <>
      <PageHeader
        title="Issues"
        exports={<ExportCsvButton href={controls.exportHref ?? "/api/export?entity=issues"} />}
        action={<NewIssueButton projects={projects} defaultProjectId={controls.filters.project_id} />}
      />

      <RegisterToolbar controls={controls} />

      <Card>
        {issues.length === 0 ? (
          <EmptyState
            purpose={
              activeFilterCount > 0
                ? `No issues match the ${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""}.`
                : "Problems that have already happened: what broke, who fixes it, when it resolved."
            }
            canWrite={canWrite}
            action={
              activeFilterCount > 0 ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : (
                <NewIssueButton projects={projects} defaultProjectId={controls.filters.project_id} />
              )
            }
            docsHref={activeFilterCount > 0 ? undefined : "/trust"}
            docsLabel="See governance in the Trust Center"
          />
        ) : (
          <>
            {/* <md: cards (DataList's own card render, hidden at md+) */}
            <div className="md:hidden">
              <IssueDataList issues={issues} projectMap={projectMap} dateDisplayPref={dateDisplayPref} />
            </div>
            {/* ≥md: grouped, sortable, column-chooser-driven table */}
            <div className="hidden md:block">
              <ScrollTable bare label="Issue register">
                <THead>
                  <TR>
                    {visibleColumns.map((col) => (
                      <TH
                        key={col.key}
                        aria-sort={
                          sort?.field === col.key ? (sort.direction === "asc" ? "ascending" : "descending") : undefined
                        }
                      >
                        {SORTABLE.has(col.key) ? (
                          <button
                            type="button"
                            onClick={() => toggleSort(col.key)}
                            aria-label={`Sort by ${col.label}`}
                            className={cn(
                              "focus-ring inline-flex items-center gap-1 rounded uppercase hover:text-ink",
                              sort?.field === col.key && "text-ink",
                            )}
                          >
                            {col.label}
                            {sort?.field === col.key &&
                              (sort.direction === "asc" ? (
                                <ArrowUp className="h-3 w-3" aria-hidden />
                              ) : (
                                <ArrowDown className="h-3 w-3" aria-hidden />
                              ))}
                          </button>
                        ) : (
                          col.label
                        )}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <tbody>
                  {groups.map((g) => (
                    <Fragment key={g.key}>
                      {g.label !== "" && (
                        <TR className="bg-well/60">
                          <TD
                            colSpan={visibleColumns.length}
                            className="text-xs font-medium uppercase tracking-wide text-ink-muted"
                          >
                            {g.label} · {g.rows.length}
                          </TD>
                        </TR>
                      )}
                      {g.rows.map((i) => (
                        <TR
                          key={i.id}
                          onClick={() => openIssue(i)}
                          className="cursor-pointer transition-colors hover:bg-well"
                        >
                          {visibleColumns.map((col) => (
                            <TD key={col.key} className="whitespace-nowrap">
                              {cell(col.key, i)}
                            </TD>
                          ))}
                        </TR>
                      ))}
                    </Fragment>
                  ))}
                </tbody>
              </ScrollTable>
            </div>
          </>
        )}
      </Card>
    </>
  );
}
