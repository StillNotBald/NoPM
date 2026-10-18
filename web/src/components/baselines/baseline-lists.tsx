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
import { ProposeRebaselineButton, RebaselineRowActions } from "./rebaseline-controls";
import type { RebaselineActionState } from "./rebaseline-rules";

export interface LockedBaselineRow {
  id: string;
  name: string;
  lockedAtText: string;
  lockedAtTitle: string;
  lockedByLabel: string;
  lockReason: string | null;
  /** The viewer may propose (project:write: not a viewer). */
  canPropose: boolean;
  /** Set when a rebaseline is already awaiting sign-off for this project. */
  proposeDisabledReason: string | null;
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
  /** Q-GOV-8: the exact dates the proposal carries, e.g. "1 Nov 2026 to 15 Dec 2026" (null when none were recorded). */
  proposedDates: string | null;
  /** What the signed-in viewer may do with it (sign off / apply / why not). */
  actions: RebaselineActionState;
  /** Opened from the Review Queue (?focus=<id>). */
  focused: boolean;
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
    {
      key: "actions",
      header: "Action",
      cell: (r) =>
        r.canPropose ? (
          <ProposeRebaselineButton projectId={r.id} projectName={r.name} disabledReason={r.proposeDisabledReason} />
        ) : (
          <span className="text-xs text-ink-muted">Read-only</span>
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
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <Badge size="sm" tone={r.statusTone}>
            {r.statusLabel}
          </Badge>
          {r.focused && (
            <Badge size="sm" tone="info">
              From Review Queue
            </Badge>
          )}
        </span>
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
      key: "dates",
      header: "Proposed dates",
      hideOnMobile: true,
      cell: (r) =>
        r.proposedDates ? (
          <span className="tabular-nums text-ink-secondary">{r.proposedDates}</span>
        ) : (
          <span className="text-ink-muted">Not recorded</span>
        ),
    },
    {
      key: "signoffs",
      header: "Sign-offs",
      cell: (r) => <span className="tabular-nums text-ink-secondary">{r.signoffLabel}</span>,
    },
    {
      key: "actions",
      header: "Action",
      cell: (r) => <RebaselineRowActions rebaselineId={r.id} projectName={r.projectName} state={r.actions} />,
    },
  ];

  return <DataList columns={columns} rows={rows} rowKey={(r) => r.id} tableClassName="min-w-[700px]" />;
}
