"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError } from "@/components/forms/project-form";

// ── Data shape ────────────────────────────────────────────────────────────────
// Mirrors the project_budget row. Enrichment fields (0008) are nullable so an
// un-enriched / freshly-created budget still hydrates the form cleanly.
export interface ProjectBudget {
  project_id: string;
  planned_amount: number;
  committed_amount: number;
  currency: string | null;
  // ── Content enrichment (0008): PMBOK actual cost + reserves ─────────────────
  actual_amount: number | null;
  contingency_reserve: number | null;
  management_reserve: number | null;
}

// `<input type="number">` yields a string; convert to a number for the JSON
// payload, or undefined when blank so the API keeps the DB default (0) instead
// of being handed NaN.
function toAmount(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

// ── BudgetForm ────────────────────────────────────────────────────────────────
export function BudgetForm({
  projectId,
  budget,
}: {
  projectId: string;
  budget?: ProjectBudget;
}) {
  const modal = useModal();
  const router = useRouter();

  const [plannedAmount, setPlannedAmount] = useState(
    budget?.planned_amount != null ? String(budget.planned_amount) : "",
  );
  const [committedAmount, setCommittedAmount] = useState(
    budget?.committed_amount != null ? String(budget.committed_amount) : "",
  );
  const [currency, setCurrency] = useState(budget?.currency ?? "USD");

  // ── Content enrichment (0008): PMBOK actual cost + reserves ─────────────────
  const [actualAmount, setActualAmount] = useState(
    budget?.actual_amount != null ? String(budget.actual_amount) : "",
  );
  const [contingencyReserve, setContingencyReserve] = useState(
    budget?.contingency_reserve != null ? String(budget.contingency_reserve) : "",
  );
  const [managementReserve, setManagementReserve] = useState(
    budget?.management_reserve != null ? String(budget.management_reserve) : "",
  );

  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function applyApiError(err: ApiError) {
    setTopError(err.message ?? "An error occurred.");
    const map: Record<string, string> = {};
    for (const f of err.fields ?? []) map[f.field] = f.message;
    setFieldErrors(map);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setTopError(null);
    setFieldErrors({});
    setSaving(true);

    const payload = {
      planned_amount: toAmount(plannedAmount) ?? 0,
      committed_amount: toAmount(committedAmount) ?? 0,
      currency: currency.trim() || "USD",
      // ── Content enrichment (0008) — omitted when blank so the DB default holds.
      actual_amount: toAmount(actualAmount),
      contingency_reserve: toAmount(contingencyReserve),
      management_reserve: toAmount(managementReserve),
    };

    try {
      await apiPatch(`/api/projects/${projectId}/budget`, payload);
      router.refresh();
      modal.close();
    } catch (err) {
      applyApiError(err as ApiError);
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {topError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger">
          {topError}
        </div>
      )}

      {/* Core budget figures */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {/* Planned amount */}
        <div>
          <FieldLabel required>Planned Amount</FieldLabel>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={plannedAmount}
            onChange={(e) => setPlannedAmount(e.target.value)}
            placeholder="0.00"
            required
            className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
          />
          <FieldError message={fieldErrors.planned_amount} />
        </div>

        {/* Committed amount */}
        <div>
          <FieldLabel>Committed Amount</FieldLabel>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={committedAmount}
            onChange={(e) => setCommittedAmount(e.target.value)}
            placeholder="0.00"
            className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
          />
          <FieldError message={fieldErrors.committed_amount} />
        </div>

        {/* Currency */}
        <div>
          <FieldLabel>Currency</FieldLabel>
          <Input
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
            placeholder="USD"
            maxLength={10}
            className="h-11 sm:h-10 text-base sm:text-sm uppercase"
          />
          <FieldError message={fieldErrors.currency} />
        </div>

        {/* Actual amount — PMBOK Actual Cost (AC) */}
        <div>
          <FieldLabel>Actual Amount</FieldLabel>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={actualAmount}
            onChange={(e) => setActualAmount(e.target.value)}
            placeholder="0.00"
            className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
          />
          <FieldError message={fieldErrors.actual_amount} />
        </div>

        {/* Contingency reserve — PMBOK known-unknowns buffer */}
        <div>
          <FieldLabel>Contingency Reserve</FieldLabel>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={contingencyReserve}
            onChange={(e) => setContingencyReserve(e.target.value)}
            placeholder="0.00"
            className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
          />
          <FieldError message={fieldErrors.contingency_reserve} />
        </div>

        {/* Management reserve — PMBOK unknown-unknowns buffer */}
        <div>
          <FieldLabel>Management Reserve</FieldLabel>
          <Input
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={managementReserve}
            onChange={(e) => setManagementReserve(e.target.value)}
            placeholder="0.00"
            className="h-11 sm:h-10 text-base sm:text-sm tabular-nums"
          />
          <FieldError message={fieldErrors.management_reserve} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={modal.close}
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || plannedAmount.trim() === ""}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : (
            "Save Budget"
          )}
        </Button>
      </div>
    </form>
  );
}
