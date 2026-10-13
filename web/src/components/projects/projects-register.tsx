"use client";

import { useMemo } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp } from "lucide-react";
import { PageHeader } from "@/components/ui/page-header";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Table, THead, TH, TR, TD } from "@/components/ui/data-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import { NewProjectButton } from "@/components/forms/new-project-button";
import { type FilterFieldConfig } from "@/components/registers/use-list-controls";
import { useRegisterToolbar, RegisterToolbar } from "@/components/registers/register-toolbar";
import { type ColumnDef } from "@/components/registers/column-chooser";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { ragLabel, ragTone, type RagStatus } from "@/lib/status";

export interface ProjectRow {
  id: string;
  code: string | null;
  name: string;
  rag_status: string;
  phase: string | null;
  completion_pct: number | null;
  target_date: string | null;
  is_locked: boolean;
  program: string | null;
}

const SEARCH_FIELD: FilterFieldConfig = { key: "q", label: "Search", type: "text", placeholder: "Project name…" };

const RAG_OPTIONS = [
  { value: "not_started", label: "Not started" },
  { value: "green", label: "Green" },
  { value: "amber", label: "Amber" },
  { value: "red", label: "Red" },
  { value: "complete", label: "Complete" },
];

const PHASE_OPTIONS = [
  { value: "initiation", label: "Initiation" },
  { value: "planning", label: "Planning" },
  { value: "execution", label: "Execution" },
  { value: "monitoring", label: "Monitoring" },
  { value: "closing", label: "Closing" },
];

const ALL_COLUMNS: readonly ColumnDef[] = [
  { key: "code", label: "Code" },
  { key: "name", label: "Name" },
  { key: "program", label: "Program" },
  { key: "rag_status", label: "RAG" },
  { key: "phase", label: "Phase" },
  { key: "completion_pct", label: "Completion" },
  { key: "target_date", label: "Target date" },
  { key: "lifecycle", label: "Lifecycle" },
];

const DEFAULT_COLUMNS = ["code", "name", "program", "rag_status", "completion_pct", "target_date", "lifecycle"];

// Mirrors the sort whitelist in app/(console)/projects/page.tsx and GET /api/export.
const SORTABLE = new Set(["name", "code", "rag_status", "phase", "completion_pct", "target_date"]);

const MUTED = <span className="text-ink-muted">—</span>;

export function ProjectsRegister({
  rows,
  programs,
  dateDisplayPref,
  canWrite,
}: {
  rows: ProjectRow[];
  programs: Array<{ id: string; name: string }>;
  dateDisplayPref: DateDisplayPref;
  canWrite: boolean;
}) {
  const programKey = programs.map((p) => p.id).join(",");
  const sheetFields = useMemoFields(programs, programKey);
  const controls = useRegisterToolbar({
    register: "projects",
    exportEntity: "projects",
    searchField: SEARCH_FIELD,
    sheetFields,
    columns: ALL_COLUMNS,
    defaultColumns: DEFAULT_COLUMNS,
  });
  const { visibleColumns, sort, toggleSort, activeFilterCount, clearFilters, exportHref } = controls;
  const cols = ALL_COLUMNS.filter((c) => visibleColumns.some((v) => v.key === c.key));

  return (
    <>
      <PageHeader
        title="Projects"
        exports={exportHref ? <ExportCsvButton href={exportHref} /> : undefined}
        action={canWrite ? <NewProjectButton /> : undefined}
      />
      <div className="mb-4 space-y-3">
        <RegisterToolbar controls={controls} />
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border-subtle bg-surface">
          {activeFilterCount > 0 ? (
            <EmptyState
              purpose="No projects match these filters."
              action={
                <button type="button" onClick={clearFilters} className="focus-ring text-sm text-accent hover:underline">
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              purpose="No projects yet. Create one to start tracking milestones, risks and budget."
              action={<NewProjectButton />}
              canWrite={canWrite}
            />
          )}
        </div>
      ) : (
        <Table>
          <THead>
            <TR>
              {cols.map((c) => {
                const sortable = SORTABLE.has(c.key);
                const active = sort?.field === c.key;
                return (
                  <TH
                    key={c.key}
                    align={c.key === "completion_pct" ? "right" : "left"}
                    aria-sort={active ? (sort!.direction === "asc" ? "ascending" : "descending") : undefined}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.key)}
                        className="focus-ring inline-flex items-center gap-1 uppercase"
                      >
                        {c.label}
                        {active && (sort!.direction === "asc" ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}
                      </button>
                    ) : (
                      c.label
                    )}
                  </TH>
                );
              })}
            </TR>
          </THead>
          <tbody>
            {rows.map((p) => (
              <TR key={p.id} className="relative transition-colors hover:bg-sunken/40">
                {cols.map((c) => (
                  <Cell key={c.key} col={c.key} p={p} pref={dateDisplayPref} />
                ))}
              </TR>
            ))}
          </tbody>
        </Table>
      )}

      {rows.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          {rows.length} project{rows.length !== 1 ? "s" : ""}
        </p>
      )}
    </>
  );
}

function useMemoFields(programs: Array<{ id: string; name: string }>, key: string): readonly FilterFieldConfig[] {
  return useMemo(
    () => [
      { key: "rag_status", label: "RAG", type: "select", options: RAG_OPTIONS },
      { key: "phase", label: "Phase", type: "select", options: PHASE_OPTIONS },
      ...(programs.length > 0
        ? [
            {
              key: "program_id",
              label: "Program",
              type: "select" as const,
              options: programs.map((p) => ({ value: p.id, label: p.name })),
            },
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );
}

function Cell({ col, p, pref }: { col: string; p: ProjectRow; pref: DateDisplayPref }) {
  switch (col) {
    case "code":
      return <TD className="whitespace-nowrap font-mono text-xs text-ink-muted">{p.code ?? "—"}</TD>;
    case "name":
      return (
        <TD className="min-w-0 font-medium">
          {/* stretched link: the whole row is clickable through a native <a> */}
          <Link
            href={`/projects/${p.id}`}
            className="focus-ring rounded hover:text-accent after:absolute after:inset-0"
          >
            {p.name}
          </Link>
        </TD>
      );
    case "program":
      return (
        <TD className="max-w-[11rem] text-ink-secondary">
          <span className="block truncate">{p.program ?? MUTED}</span>
        </TD>
      );
    case "rag_status":
      return (
        <TD>
          <Badge size="sm" tone={ragTone(p.rag_status as RagStatus)}>
            {ragLabel(p.rag_status as RagStatus)}
          </Badge>
        </TD>
      );
    case "phase":
      return <TD className="capitalize text-ink-secondary">{p.phase ?? MUTED}</TD>;
    case "completion_pct":
      return (
        <TD>
          <div className="flex items-center justify-end gap-2">
            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-sunken">
              <div className="h-full rounded-full bg-accent" style={{ width: `${p.completion_pct ?? 0}%` }} />
            </div>
            <span className="w-8 whitespace-nowrap text-right text-xs tabular-nums text-ink-secondary">
              {Math.round(p.completion_pct ?? 0)}%
            </span>
          </div>
        </TD>
      );
    case "target_date": {
      if (!p.target_date) return <TD>{MUTED}</TD>;
      const f = formatByPref(p.target_date, pref);
      return (
        <TD className="whitespace-nowrap text-xs tabular-nums text-ink-secondary">
          <time dateTime={f.title} title={f.absolute}>
            {f.text}
          </time>
        </TD>
      );
    }
    case "lifecycle":
      return (
        <TD>
          {p.is_locked ? (
            <Badge size="sm" tone="warning">
              Locked
            </Badge>
          ) : (
            <span className="text-xs text-ink-muted">Active</span>
          )}
        </TD>
      );
    default:
      return <TD>{MUTED}</TD>;
  }
}
