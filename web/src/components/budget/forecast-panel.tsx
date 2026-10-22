"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { apiPatch } from "@/lib/api-client";
import { Disclosure } from "@/components/integrations/shared";

/**
 * Forecast at completion and trend, one block per project (audit gaps B3 + B6).
 *
 * B3: both forecasts side by side (by cost performance, and bottom-up = spent +
 * committed + the to-finish estimate), the manual to-finish input and the choice of
 * which one the project reports as its EAC.
 * B6: the declared RAG next to the RAG the snapshot trend SUGGESTS. The suggestion is
 * advice: nothing here writes the RAG.
 *
 * A "use client" wrapper because the inputs save through the budget API; the (server)
 * page pre-formats every figure and passes plain data down.
 */

export interface ForecastRow {
  projectId: string;
  projectName: string;
  currency: string;
  committedDisplay: string;
  actualDisplay: string;
  eacCpiDisplay: string;
  eacBottomUpDisplay: string;
  /** The manual to-finish estimate as the stored number, or null when none. */
  estimateToComplete: number | null;
  /** Commitments not yet invoiced, or null when not tracked separately (then committed is used). */
  committedOpen: number | null;
  method: "cpi" | "bottom_up";
  declaredRag: string | null;
  suggestion: { rag: "green" | "amber" | "red"; reason: string; snapshots: number; lowConfidence: boolean } | null;
}

const RAG_TONE = { green: "success", amber: "warning", red: "danger" } as const;

function declaredTone(rag: string | null): "success" | "warning" | "danger" | "neutral" {
  if (rag === "green" || rag === "complete") return "success";
  if (rag === "amber") return "warning";
  if (rag === "red") return "danger";
  return "neutral";
}

function ForecastBlock({ row }: { row: ForecastRow }) {
  const router = useRouter();
  const toast = useToast();
  const uid = useId();
  const [etc, setEtc] = useState(row.estimateToComplete === null ? "" : String(row.estimateToComplete));
  const [open, setOpen] = useState(row.committedOpen === null ? "" : String(row.committedOpen));
  const [method, setMethod] = useState(row.method);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    method !== row.method ||
    (etc.trim() === "" ? null : Number(etc)) !== row.estimateToComplete ||
    (open.trim() === "" ? null : Number(open)) !== row.committedOpen;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const value = etc.trim() === "" ? null : Number(etc);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      setError("To-finish must be a number, zero or more. Leave it empty if you have no estimate yet.");
      return;
    }
    const openValue = open.trim() === "" ? null : Number(open);
    if (openValue !== null && (!Number.isFinite(openValue) || openValue < 0)) {
      setError("Open commitments must be a number, zero or more. Leave it empty to use the committed amount.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPatch(`/api/projects/${row.projectId}/budget`, {
        estimate_to_complete: value,
        committed_open: openValue,
        forecast_method: method,
      });
      toast.success("Forecast saved.");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the forecast.");
    } finally {
      setSaving(false);
    }
  }

  const bottomUpMissing = method === "bottom_up" && row.estimateToComplete === null;

  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="min-w-0 break-words text-sm font-medium text-ink">{row.projectName}</span>
        <span className="flex items-center gap-1.5 text-xs text-ink-muted">
          Declared RAG
          <Badge tone={declaredTone(row.declaredRag)} size="sm">
            {row.declaredRag ? row.declaredRag.replace("_", " ") : "not set"}
          </Badge>
        </span>
      </div>

      {row.suggestion ? (
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-ink-secondary">
          <span>Suggested RAG:</span>
          <Badge tone={RAG_TONE[row.suggestion.rag]} size="sm">
            {row.suggestion.rag}
          </Badge>
          <span className="min-w-0 break-words">({row.suggestion.reason})</span>
          <span className="text-ink-muted">
            {row.suggestion.lowConfidence
              ? `Early read from ${row.suggestion.snapshots} snapshot${row.suggestion.snapshots === 1 ? "" : "s"}. `
              : ""}
            Advice only; the declared RAG is yours to set.
          </span>
        </p>
      ) : (
        <p className="text-xs text-ink-muted">
          No RAG suggestion yet. A trend appears after the first nightly snapshot.
        </p>
      )}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs sm:grid-cols-4 [&>div]:min-w-0">
        <div>
          <dt className="text-ink-muted">Spent (expenses)</dt>
          <dd className="truncate font-mono tabular-nums text-ink">{row.actualDisplay}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">Committed</dt>
          <dd className="truncate font-mono tabular-nums text-ink">{row.committedDisplay}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">EAC by cost performance</dt>
          <dd className="truncate font-mono tabular-nums text-ink">{row.eacCpiDisplay}</dd>
        </div>
        <div>
          <dt className="text-ink-muted">EAC bottom-up</dt>
          <dd className="truncate font-mono tabular-nums text-ink">{row.eacBottomUpDisplay}</dd>
        </div>
      </dl>

      <form onSubmit={save} className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${uid}-open`} className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Open commitments ({row.currency})
          </label>
          <Input
            id={`${uid}-open`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="w-full"
            value={open}
            onChange={(e) => setOpen(e.target.value)}
            placeholder="Same as committed"
            aria-describedby={`${uid}-hint`}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${uid}-etc`} className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            To finish, beyond committed ({row.currency})
          </label>
          <Input
            id={`${uid}-etc`}
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            className="w-full"
            value={etc}
            onChange={(e) => setEtc(e.target.value)}
            placeholder="No estimate yet"
            aria-describedby={`${uid}-hint`}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <label htmlFor={`${uid}-method`} className="block text-xs font-semibold uppercase tracking-wider text-ink-muted">
            Report the forecast as
          </label>
          <Select
            id={`${uid}-method`}
            className="w-full"
            value={method}
            onChange={(e) => setMethod(e.target.value as "cpi" | "bottom_up")}
          >
            <option value="cpi">By cost performance (budget / CPI)</option>
            <option value="bottom_up">Bottom-up (spent + committed + to finish)</option>
          </Select>
        </div>
        <Button type="submit" variant="secondary" className="h-11 w-full sm:h-10 sm:w-auto" disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save forecast"}
        </Button>
        <p id={`${uid}-hint`} className="text-xs text-ink-muted sm:col-span-4">
          Open commitments are not yet invoiced. Reduce them as invoices arrive.
          If left empty, the committed amount is used, which can count an invoiced commitment twice.
        </p>
        <div className="sm:col-span-4">
          <Disclosure summary="How this works">
            <p className="text-xs text-ink-muted">
              Actual counts expenses only, so an invoiced commitment is counted once, as spent. To-finish is only what comes after the open commitments.
            </p>
          </Disclosure>
        </div>
        {bottomUpMissing && (
          <p role="status" className="text-xs text-warning-ink sm:col-span-4">
            Bottom-up needs a to-finish estimate. Until then there is no forecast.
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-danger-ink sm:col-span-4">
            {error}
          </p>
        )}
      </form>
    </li>
  );
}

export function ForecastPanel({ rows, trendAvailable }: { rows: ForecastRow[]; trendAvailable: boolean }) {
  return (
    <>
      {!trendAvailable && (
        <p className="border-b border-border-subtle px-5 py-3 text-xs text-ink-muted">
          No trend history yet, so no RAG is suggested.
        </p>
      )}
      <ul className="divide-y divide-border-subtle">
        {rows.map((r) => (
          <ForecastBlock key={r.projectId} row={r} />
        ))}
      </ul>
    </>
  );
}
