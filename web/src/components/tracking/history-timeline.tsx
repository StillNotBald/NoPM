"use client";

import { useEffect, useState } from "react";
import { apiGet } from "@/lib/api-client";
import { TerminalCard } from "@/components/ui/terminal-card";
import { formatAbsoluteDate } from "@/lib/format/dates";

// ─── Data shape ────────────────────────────────────────────────────────────────
// Mirrors the immutable `audit_log` row surfaced by GET /api/audit.

interface AuditRow {
  id: string;
  action: string;
  actor_type: "user" | "token" | string;
  actor_label: string;
  target_type: string;
  target_id: string | null;
  created_at: string;
}

interface HistoryTimelineProps {
  /** When provided, history is scoped to this project (target_type=project). */
  projectId?: string;
  /** Optional override to scope by an arbitrary audit target. */
  targetType?: string;
  targetId?: string;
  /** Max rows to request (defaults to 50). */
  limit?: number;
}

// ─── Time formatting ───────────────────────────────────────────────────────────

function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return formatAbsoluteDate(iso);
}

// ─── HistoryTimeline ───────────────────────────────────────────────────────────

/**
 * Terminal-style read-only timeline of immutable audit rows for a target
 * (a project by default). Renders `actor_label · action · time` in a mono
 * column, matching the governance "provenance" aesthetic of the Trust Center.
 */
export function HistoryTimeline({
  projectId,
  targetType,
  targetId,
  limit = 50,
}: HistoryTimelineProps) {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve the effective audit query target.
  const effectiveType = targetType ?? (projectId ? "project" : undefined);
  const effectiveId = targetId ?? projectId;

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setRows(null);
      setError(null);

      const params = new URLSearchParams();
      params.set("limit", String(limit));
      if (effectiveType !== undefined) params.set("target_type", effectiveType);
      if (effectiveId !== undefined) params.set("target_id", effectiveId);

      try {
        const data = await apiGet<AuditRow[]>(`/api/audit?${params.toString()}`);
        if (!cancelled) setRows(data);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Failed to load history");
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [effectiveType, effectiveId, limit]);

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-ink">History</h2>
        <span className="text-xs text-ink-muted">Immutable audit trail</span>
      </div>

      <TerminalCard title="audit_log">
        {/* Body */}
        <div className="max-h-[28rem] overflow-y-auto px-4 py-3 font-mono text-xs leading-relaxed">
          {error && (
            <p className="text-terminal-red-ink">
              <span className="text-terminal-text-muted">$ </span>
              error: {error}
            </p>
          )}

          {!error && rows === null && (
            <p className="text-terminal-text-muted">
              <span className="text-terminal-text-muted">$ </span>
              loading audit trail…
            </p>
          )}

          {!error && rows !== null && rows.length === 0 && (
            <p className="text-terminal-text-muted">
              <span className="text-terminal-text-muted">$ </span>
              no audit events recorded for this target yet.
            </p>
          )}

          {!error && rows !== null && rows.length > 0 && (
            <ol className="space-y-1.5">
              {rows.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-terminal-text"
                  title={absoluteTime(row.created_at)}
                >
                  <span className="text-terminal-green-ink">{row.actor_label}</span>
                  <span className="text-terminal-text-muted">·</span>
                  <span className="text-terminal-amber-ink">{row.action}</span>
                  <span className="text-terminal-text-muted">·</span>
                  <time dateTime={row.created_at} className="text-terminal-text-muted">
                    {relativeTime(row.created_at)}
                  </time>
                </li>
              ))}
            </ol>
          )}
        </div>
      </TerminalCard>
    </section>
  );
}
