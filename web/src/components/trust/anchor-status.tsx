"use client";

import { useEffect, useState } from "react";
import { Anchor, ShieldAlert, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { toAnchorView, type AnchorView } from "@/lib/audit/anchor/view";
import { cn } from "@/lib/cn";

/**
 * Where the audit chain head is kept outside the database (R-170, migration 0112). Always shown to
 * the admins and managers who see the chain badge: never green when there is nothing to be green
 * about, never hidden.
 *
 *   anchored       green    "Anchored <time> (n rows)"
 *   behind         neutral  "Anchored <time> (n rows), N rows behind"
 *   not_anchored   neutral  "Not anchored" and one line on how to turn it on
 *   unreachable    amber    "Anchor unreachable since <time>"  (a failed copy never blocks work)
 *   mismatch       red      "Anchor mismatch"  (the log no longer matches the outside copy)
 *
 * The first paint comes from the server. The chain badge announces a fresh verify by dispatching
 * `nopm:audit-verified` with the `anchor` object of the verify response as `detail`; this component
 * then updates itself. Phone width: everything wraps, no horizontal scroll.
 */
export const AUDIT_VERIFIED_EVENT = "nopm:audit-verified";

function when(iso: string | null): string {
  if (!iso) return "at an unknown time";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

const rows = (n: number | null) => (n === null ? "" : ` (${n.toLocaleString("en-GB")} rows)`);

export function AnchorStatus({ anchor, asOf = null, className }: { anchor: AnchorView | null; /** ISO time of the last check this state is drawn from (W2-18). */ asOf?: string | null; className?: string }) {
  const [view, setView] = useState<AnchorView | null>(anchor);
  const [checkedAt, setCheckedAt] = useState<string | null>(asOf);

  useEffect(() => {
    const onVerified = (e: Event) => {
      const next = toAnchorView((e as CustomEvent).detail);
      if (next) {
        setView(next);
        setCheckedAt(new Date().toISOString());
      }
    };
    window.addEventListener(AUDIT_VERIFIED_EVENT, onVerified);
    return () => window.removeEventListener(AUDIT_VERIFIED_EVENT, onVerified);
  }, []);

  const a = view ?? { state: "not_anchored" as const, chain_seq: null, anchored_at: null, row_count: null, rows_behind: null, since: null, reset_at: null };
  const bad = a.state === "mismatch";
  const warn = a.state === "unreachable";

  return (
    <div
      data-testid="anchor-status"
      data-state={a.state}
      role={bad ? "alert" : "status"}
      className={cn(
        "flex min-w-0 flex-col gap-1 rounded-md border bg-surface p-3 text-sm",
        bad ? "border-danger" : warn ? "border-warning" : "border-border-subtle",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        {bad ? (
          <ShieldAlert size={16} className="shrink-0 text-danger" aria-hidden />
        ) : warn ? (
          <TriangleAlert size={16} className="shrink-0 text-warning" aria-hidden />
        ) : (
          <Anchor size={16} className="shrink-0 text-ink-secondary" aria-hidden />
        )}
        {a.state === "anchored" && (
          <>
            <Badge tone="success">Anchored</Badge>
            <span className="min-w-0 break-words text-ink-secondary">
              {when(a.anchored_at)}
              {rows(a.row_count)}
            </span>
          </>
        )}
        {a.state === "behind" && (
          <>
            <Badge tone="neutral">Anchored</Badge>
            <span className="min-w-0 break-words text-ink-secondary">
              {when(a.anchored_at)}
              {rows(a.row_count)}, {(a.rows_behind ?? 0).toLocaleString("en-GB")} rows behind
            </span>
          </>
        )}
        {a.state === "not_anchored" && <Badge tone="neutral">Not anchored</Badge>}
        {a.state === "unreachable" && (
          <>
            <Badge tone="warning">Anchor unreachable</Badge>
            <span className="min-w-0 break-words text-ink-secondary">since {when(a.since)}</span>
          </>
        )}
        {a.state === "mismatch" && (
          <>
            <Badge tone="danger">Anchor mismatch</Badge>
            <span className="min-w-0 break-words text-danger-ink">since {when(a.since)}</span>
          </>
        )}
      </div>
      {a.state === "not_anchored" && (
        <p className="m-0 break-words text-ink-secondary">
          The audit chain head is not kept outside this database. Set NOPM_ANCHOR_DB_URL to a second database to anchor it.
        </p>
      )}
      {a.state === "unreachable" && (
        <p className="m-0 break-words text-ink-secondary">
          The outside copy could not be written or read. Work is not affected. The next daily run retries.
          {a.anchored_at ? ` Last anchored ${when(a.anchored_at)}.` : ""}
        </p>
      )}
      {a.reset_at && (a.state === "anchored" || a.state === "behind") && (
        <p className="m-0 break-words text-ink-secondary">Re-baselined on {when(a.reset_at)} after a restore.</p>
      )}
      {a.state !== "not_anchored" && (
        <p className="m-0 break-words text-2xs text-ink-muted" data-testid="anchor-as-of">
          {checkedAt ? `State as of the last check, ${when(checkedAt)}.` : "No check yet. This is the last daily run."}
        </p>
      )}
      {a.state === "mismatch" && (
        <p className="m-0 break-words text-danger-ink">
          The audit log no longer matches the outside copy. Treat the log as altered until this is explained.
        </p>
      )}
    </div>
  );
}
