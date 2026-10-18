"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatByPref } from "@/lib/format/dates";
import { useDateDisplayPref } from "@/lib/theme/use-appearance";

export interface PendingApproval {
  id: string;
  target_type: string;
  target_id: string;
  /** Name of the thing being deleted, from the request's snapshot (`before.name`); null if unknown. */
  target_name?: string | null;
  requested_by_label: string;
  reason: string | null;
  created_at: string;
}

function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function ApprovalRow({ approval }: { approval: PendingApproval }) {
  const pref = useDateDisplayPref();
  return (
    <Link
      href="/approvals"
      className="focus-ring flex min-h-11 flex-col gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-well sm:min-h-0 sm:flex-row sm:items-center sm:gap-3 sm:py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        {/* Type badge */}
        <Badge tone="danger" className="shrink-0">
          {approval.target_type}
        </Badge>

        {/* What is being deleted: its name when the request carries one,
            otherwise the short id (kept as a hover title either way) */}
        {approval.target_name ? (
          <span className="min-w-0 shrink font-medium text-ink" title={approval.target_id}>
            <span className="block truncate">{approval.target_name}</span>
          </span>
        ) : (
          <code className="shrink-0 rounded bg-well px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            {shortId(approval.target_id)}
          </code>
        )}

        {/* Reason / requester */}
        <span className="min-w-0 flex-1 truncate text-ink-secondary">
          <span className="text-ink-muted">by </span>
          <span className="font-medium text-ink">{approval.requested_by_label}</span>
          {approval.reason && (
            <span className="text-ink-muted"> · {approval.reason}</span>
          )}
        </span>
      </div>

      {/* Date */}
      <span className="shrink-0 pl-[1.125rem] font-mono text-xs tabular-nums text-ink-muted sm:pl-0">
        {formatByPref(approval.created_at, pref).text}
      </span>
    </Link>
  );
}
