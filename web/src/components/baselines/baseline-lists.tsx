"use client";

/**
 * Baselines register (F5) — responsive lists: table ≥md, cards <md.
 *
 * Read-only page (see app/(console)/baselines/page.tsx) — the write path is
 * the API/agent surfaces, not this UI — so these lists never take an
 * onRowClick; the project name cell is itself an <EntityLink>, which is
 * already the row's only actionable element on every breakpoint.
 */

import { Badge } from "@/components/ui/badge";
import { EntityLink } from "@/components/ui/entity-link";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import type { Tone } from "@/lib/status";

export interface LockedBaselineRow {
  id: string;
  name: string;
  lockedAtText: string;
  lockedAtTitle: string;
  lockedByLabel: string;
  lockReason: string | null;
}

export interface RebaselineRow {
  id: string;
  projectId: string;
  projectName: string;
  status: string;
  statusLabel: string;
  statusTone: Tone;
  requestedText: string;
  requestedTitle: string;
  signoffLabel: string;
}

export function LockedBaselinesList({
  rows,
  purpose,
}: {
  rows: LockedBaselineRow[];
  purpose: string;
}) {
  if (rows.length === 0) {
    return <EmptyState purpose={purpose} />;
  }

  const columns: DataListColumn<LockedBaselineRow>[] = [
    {
      key: "project",
      header: "Project",
      primary: true,
      cell: (r) => (
        <span className="block min-w-0 max-w-[220px]">
          <EntityLink kind="project" id={r.id}>
            {r.name}
          </EntityLink>
        </span>
      ),
    },
    {
      key: "locked_at",
      header: "Locked at",
      cell: (r) => (
        <span className="tabular-nums text-ink-secondary" title={r.lockedAtTitle}>
          {r.lockedAtText}
        </span>
      ),
    },
    {
      key: "locked_by",
      header: "Locked by",
      cell: (r) => <span className="text-ink-secondary">{r.lockedByLabel}</span>,
    },
    {
      key: "lock_reason",
      header: "Lock reason",
      hideOnMobile: true,
      cell: (r) =>
        r.lockReason ? (
          <span className="block min-w-0 max-w-xs text-ink-secondary">{r.lockReason}</span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
  ];

  return <DataList columns={columns} rows={rows} rowKey={(r) => r.id} tableClassName="min-w-[700px]" />;
}

export function RebaselinesList({
  rows,
  purpose,
}: {
  rows: RebaselineRow[];
  purpose: string;
}) {
  if (rows.length === 0) {
    return <EmptyState purpose={purpose} />;
  }

  const columns: DataListColumn<RebaselineRow>[] = [
    {
      key: "project",
      header: "Project",
      primary: true,
      cell: (r) => (
        <span className="block min-w-0 max-w-[220px]">
          <EntityLink kind="project" id={r.projectId}>
            {r.projectName}
          </EntityLink>
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (r) => (
        <Badge size="sm" tone={r.statusTone}>
          {r.statusLabel}
        </Badge>
      ),
    },
    {
      key: "requested",
      header: "Requested",
      cell: (r) => (
        <span className="tabular-nums text-ink-secondary" title={r.requestedTitle}>
          {r.requestedText}
        </span>
      ),
    },
    {
      key: "signoffs",
      header: "Sign-offs",
      cell: (r) => <span className="tabular-nums text-ink-secondary">{r.signoffLabel}</span>,
    },
  ];

  return <DataList columns={columns} rows={rows} rowKey={(r) => r.id} tableClassName="min-w-[700px]" />;
}
