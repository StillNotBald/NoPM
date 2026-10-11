"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export interface PendingApproval {
  id: string;
  target_type: string;
  target_id: string;
  requested_by_label: string;
  reason: string | null;
  created_at: string;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function shortId(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function ApprovalRow({ approval }: { approval: PendingApproval }) {
  return (
    <Link
      href="/approvals"
      className="flex flex-col gap-2 rounded-md px-3 py-2.5 text-sm transition-colors hover:bg-sunken sm:flex-row sm:items-center sm:gap-3 sm:py-2"
    >
      <div className="flex min-w-0 items-center gap-3">
        {/* Type badge */}
        <Badge tone="danger" className="shrink-0">
          {approval.target_type}
        </Badge>

        {/* Target ID chip */}
        <code className="shrink-0 rounded bg-sunken px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          {shortId(approval.target_id)}
        </code>

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
        {formatDate(approval.created_at)}
      </span>
    </Link>
  );
}
