"use client";

import { useState } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

/**
 * Audit hash-chain status (R-154). Shows the result of the last check and a "Verify now" button
 * that calls GET /api/audit/verify (admin or manager session only; render it only for them).
 * Each check is itself recorded in the audit log as `audit.verified`.
 *
 * Phone width: the status line wraps and the button is a full-width 44px row below sm.
 */
export type ChainCheck = {
  ok: boolean;
  checked: number;
  /** ISO time of the check. */
  at: string;
  firstBadId?: string | null;
  firstBadAt?: string | null;
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function ChainBadge({ initial, className }: { initial: ChainCheck | null; className?: string }) {
  const [check, setCheck] = useState<ChainCheck | null>(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function verify() {
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/audit/verify", { cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (res.status === 429 && body?.code === "verify_throttled") {
        // Checked within the last 5 minutes: show that result and say when to try again.
        const l = body.last_result;
        if (l && typeof l.ok === "boolean") {
          setCheck({ ok: l.ok, checked: Number(l.checked ?? 0), at: l.recorded_at ?? l.verified_at, firstBadId: l.first_bad_id ?? null, firstBadAt: l.first_bad_at ?? null });
        }
        throw new Error(`Checked a moment ago. Try again in ${Math.ceil((body.retry_after_seconds ?? 300) / 60)} min.`);
      }
      if (!res.ok) throw new Error(body?.error ?? `Verification failed (${res.status})`);
      const d = body.data;
      setCheck({ ok: d.ok, checked: d.checked, at: d.verified_at, firstBadId: d.first_bad_id, firstBadAt: d.first_bad_at });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setBusy(false);
    }
  }

  const broken = check !== null && !check.ok;
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border border-border-subtle bg-surface p-3 sm:flex-row sm:items-center sm:justify-between",
        className,
      )}
      data-testid="chain-badge"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {broken ? <ShieldAlert size={16} className="text-danger" /> : <ShieldCheck size={16} className="text-success" />}
        {check === null ? (
          <span className="text-ink-secondary">Chain not checked yet</span>
        ) : check.ok ? (
          <>
            <Badge tone="success">Chain verified</Badge>
            <span className="text-ink-secondary">
              {check.checked.toLocaleString("en-GB")} rows, last check {when(check.at)}
            </span>
          </>
        ) : (
          <>
            <Badge tone="danger">Chain broken</Badge>
            <span className="text-ink-secondary">
              first mismatch at row {check.firstBadId ?? "unknown"}
              {check.firstBadAt ? ` (${when(check.firstBadAt)})` : ""}, checked {when(check.at)}
            </span>
          </>
        )}
        {err && <span role="alert" className="text-danger-ink">{err}</span>}
      </div>
      <button
        type="button"
        onClick={verify}
        disabled={busy}
        className={cn(
          "inline-flex h-11 items-center justify-center rounded-md border border-border-subtle bg-surface px-3 text-sm font-medium text-ink",
          "transition-colors duration-150 hover:bg-well focus:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60 sm:h-9",
        )}
      >
        {busy ? "Verifying…" : "Verify now"}
      </button>
    </div>
  );
}
