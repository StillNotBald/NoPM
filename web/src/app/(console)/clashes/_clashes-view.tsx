"use client";

import { Fragment, useMemo, type ReactNode } from "react";
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
import { type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { useRegisterToolbar, RegisterToolbar } from "@/components/registers/register-toolbar";
import { type GroupByOption } from "@/components/registers/group-by-select";
import { type ColumnDef } from "@/components/registers/column-chooser";
import type { ClashRow } from "./_types";

type ClashSeverity = "low" | "medium" | "high" | "critical";

const TYPE_OPTIONS = [
  { value: "schedule", label: "Schedule" },
  { value: "resource", label: "Resource" },
  { value: "dependency", label: "Dependency" },
];
const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "investigating", label: "Investigating" },
  { value: "resolved", label: "Resolved" },
];

const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "reference_id", label: "Ref" },
  { key: "title", label: "Title" },
  { key: "type", label: "Type" },
  { key: "severity", label: "Severity" },
  { key: "projects", label: "Projects" },
  { key: "status", label: "Status" },
  { key: "details", label: "Details" },
];
// Type is a Columns-chooser extra: when it's off, the Title cell carries a Type
// badge instead, so nothing is lost and the Status / Details columns stay in view.
const DEFAULT_COLUMNS = ["reference_id", "title", "severity", "projects", "status", "details"];

// Columns whose content may wrap; every other cell stays on one line.
const WRAPPING_COLUMNS = new Set(["projects", "details"]);

const GROUP_BY_OPTIONS: readonly GroupByOption[] = [
  { value: "project", label: "Project" },
  { value: "type", label: "Type" },
  { value: "status", label: "Status" },
  { value: "severity", label: "Severity" },
];

function typeTone(t: string) {
  if (t === "resource") return "warning" as const;
  if (t === "dependency") return "danger" as const;
  return "info" as const; // schedule
}
function statusTone(s: string) {
  if (s === "resolved") return "success" as const;
  if (s === "investigating") return "info" as const;
  return "warning" as const; // open
}
function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function ClashesView({
  clashes,
  projects,
  projectMap,
}: {
  clashes: ClashRow[];
  projects: { id: string; name: string }[];
  projectMap: Record<string, string>;
}) {
  const sheetFields = useMemo<readonly FilterFieldConfig[]>(
    () => [
      { key: "type", label: "Type", type: "select", options: TYPE_OPTIONS },
      { key: "status", label: "Status", type: "select", options: STATUS_OPTIONS },
      {
        key: "project_id",
        label: "Project",
        type: "select",
        options: projects.map((p) => ({ value: p.id, label: p.name })),
      },
    ],
    [projects],
  );

  // GET /api/export?entity=clashes takes no filters (it mirrors GET /api/clashes),
  // so the CSV is the full workspace register regardless of the on-screen filters.
  const controls = useRegisterToolbar({
    register: "clashes",
    exportEntity: "clashes",
    sheetFields,
    columns: ALL_COLUMNS,
    defaultColumns: DEFAULT_COLUMNS,
    groupByOptions: GROUP_BY_OPTIONS,
    // The phone card list below groups, so Group by stays useful there.
    phoneGroupBy: true,
    pageSize: 1000,
  });
  const { visibleColumns, groupBy, activeFilterCount, clearFilters } = controls;

  const pname = (id: string) => projectMap[id] ?? id.slice(0, 8) + "…";

  const groups = useMemo(() => {
    if (!groupBy) return [{ key: "__all__", label: "", rows: clashes }];
    const order: string[] = [];
    const buckets = new Map<string, { key: string; label: string; rows: ClashRow[] }>();
    for (const row of clashes) {
      let key: string;
      let label: string;
      if (groupBy === "project") {
        // A clash spans two projects; it is filed under its primary project (A, else B).
        const pid = row.project_a_id ?? row.project_b_id;
        key = pid ?? "__none__";
        label = pid ? (projectMap[pid] ?? "Unknown project") : "No project";
      } else {
        const v = (groupBy === "type" ? row.type : groupBy === "status" ? row.status : row.severity) ?? "";
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
  }, [clashes, groupBy, projectMap]);

  function projectsCell(c: ClashRow): ReactNode {
    return (
      <span className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
        {c.project_a_id && (
          <EntityLink kind="project" id={c.project_a_id} muted>
            {pname(c.project_a_id)}
          </EntityLink>
        )}
        {c.project_a_id && c.project_b_id && <span className="text-ink-muted">/</span>}
        {c.project_b_id && (
          <EntityLink kind="project" id={c.project_b_id} muted>
            {pname(c.project_b_id)}
          </EntityLink>
        )}
        {!c.project_a_id && !c.project_b_id && <span className="text-ink-muted">—</span>}
      </span>
    );
  }

  function cell(key: string, c: ClashRow): ReactNode {
    switch (key) {
      case "reference_id":
        return c.reference_id ? (
          <span className="whitespace-nowrap rounded border border-border-subtle bg-well px-1.5 py-0.5 font-mono text-xs text-ink-muted">
            {c.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        );
      case "title": {
        const typeColumnHidden = !visibleColumns.some((v) => v.key === "type");
        return (
          <div className="min-w-0 max-w-[13rem]">
            <span className="block truncate font-medium text-ink" title={c.title}>
              {c.title}
            </span>
            {(typeColumnHidden || c.type === "resource") && (
              <span className="mt-0.5 flex flex-wrap items-center gap-1">
                {typeColumnHidden && (
                  <Badge size="sm" tone={typeTone(c.type)}>
                    {cap(c.type)}
                  </Badge>
                )}
                {c.type === "resource" && (
                  <Badge tone="neutral" size="sm">
                    auto
                  </Badge>
                )}
              </span>
            )}
          </div>
        );
      }
      case "type":
        return (
          <Badge size="sm" tone={typeTone(c.type)}>
            {cap(c.type)}
          </Badge>
        );
      case "severity":
        return <Severity level={c.severity as ClashSeverity} />;
      case "projects":
        return <div className="min-w-0 max-w-[12rem]">{projectsCell(c)}</div>;
      case "status":
        return (
          <Badge size="sm" tone={statusTone(c.status)}>
            {cap(c.status)}
          </Badge>
        );
      case "details":
        return (
          <div className="max-w-[17rem]">
            {c.over_allocation_pct != null && (
              <span className="mb-1 inline-flex items-center gap-1 whitespace-nowrap rounded border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-xs font-medium tabular-nums text-warning-ink">
                +{Number(c.over_allocation_pct).toFixed(0)}% over
              </span>
            )}
            {c.description && (
              <p className="line-clamp-2 text-xs leading-snug text-ink-secondary">{c.description}</p>
            )}
            {c.recommended_action && (
              <p className="mt-1 line-clamp-2 text-xs italic leading-snug text-ink-muted">{c.recommended_action}</p>
            )}
            {c.over_allocation_pct == null && !c.description && !c.recommended_action && (
              <span className="text-ink-muted">—</span>
            )}
          </div>
        );
      default:
        return null;
    }
  }

  return (
    <>
      <PageHeader
        title="Clashes"
        exports={<ExportCsvButton href={controls.exportHref ?? "/api/export?entity=clashes"} />}
      />

      <RegisterToolbar controls={controls} />

      <div className="flex items-center gap-2 text-xs text-ink-muted">
        <Badge tone="neutral" size="sm">
          auto
        </Badge>
        <span>= system-detected resource over-allocation</span>
      </div>

      <Card>
        {clashes.length === 0 ? (
          // Clashes are system-detected — there is no manual "New Clash" action,
          // so the empty state is explanatory only (plus clear-filters when filtered).
          <EmptyState
            purpose={
              activeFilterCount > 0
                ? `No clashes match the ${activeFilterCount} active filter${activeFilterCount > 1 ? "s" : ""}.`
                : "Clashes are detected automatically — schedule, resource, and dependency conflicts across every project surface here as soon as NoPM finds one."
            }
            canWrite={activeFilterCount > 0}
            action={
              activeFilterCount > 0 ? (
                <Button variant="secondary" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              ) : undefined
            }
            docsHref={activeFilterCount > 0 ? undefined : "/trust"}
            docsLabel="See governance in the Trust Center"
          />
        ) : (
          <>
            {/* <md: cards. Both renders carry a DOM id so the ?clash=<id> deep-link
                opener can scroll to / highlight whichever copy is visible. */}
            <div className="md:hidden">
              {groups.map((g) => (
                <Fragment key={g.key}>
                  {g.label !== "" && (
                    <p className="border-b border-border-subtle bg-well/60 px-4 py-1.5 text-xs font-medium uppercase tracking-wide text-ink-muted">
                      {g.label} · {g.rows.length}
                    </p>
                  )}
                  <ul className="divide-y divide-border-subtle">
                    {g.rows.map((c) => (
                      <li key={c.id} id={`clash-m-${c.id}`} className="flex min-h-[44px] flex-col gap-1.5 px-4 py-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">{c.title}</span>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                              {c.reference_id && (
                                <span className="rounded border border-border-subtle bg-well px-1.5 py-0.5 font-mono text-xs text-ink-muted">
                                  {c.reference_id}
                                </span>
                              )}
                              {c.type === "resource" && (
                                <Badge tone="neutral" size="sm">
                                  auto
                                </Badge>
                              )}
                              <Badge size="sm" tone={typeTone(c.type)}>
                                {cap(c.type)}
                              </Badge>
                              <Badge size="sm" tone={statusTone(c.status)}>
                                {cap(c.status)}
                              </Badge>
                            </div>
                          </div>
                          <Severity level={c.severity as ClashSeverity} />
                        </div>
                        <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
                          <span className="shrink-0 text-ink-muted">Projects</span>
                          {projectsCell(c)}
                        </div>
                        {cell("details", c)}
                      </li>
                    ))}
                  </ul>
                </Fragment>
              ))}
            </div>

            {/* ≥md: table */}
            <div className="hidden md:block">
              <ScrollTable bare label="Clash register">
                <THead>
                  <TR>
                    {visibleColumns.map((col) => (
                      <TH key={col.key}>{col.label}</TH>
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
                      {g.rows.map((c) => (
                        <TR key={c.id} id={`clash-${c.id}`} className="transition-colors hover:bg-well">
                          {visibleColumns.map((col) => (
                            <TD
                              key={col.key}
                              className={WRAPPING_COLUMNS.has(col.key) ? "align-top" : "whitespace-nowrap align-top"}
                            >
                              {cell(col.key, c)}
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
