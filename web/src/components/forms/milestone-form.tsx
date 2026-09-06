"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import {
  FieldLabel,
  FieldError,
  SelectInput,
  TextareaInput,
} from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { validateFields } from "@/lib/forms/validate";

// ── Data shape ────────────────────────────────────────────────────────────────
export interface Milestone {
  id: string;
  project_id: string;
  name: string;
  target_date: string | null;
  status: "not_started" | "on_track" | "at_risk" | "delayed" | "completed";
  completion_pct: number;
  owner_id: string | null;
  sort_order: number;
  // Content-enrichment P0 fields (additive — optional so existing callers
  // that build a Milestone without them still typecheck).
  description?: string | null;
  deliverable?: string | null;
  start_date?: string | null;
  baseline_target_date?: string | null;
  actual_date?: string | null;
}

// ── MilestoneForm ─────────────────────────────────────────────────────────────
export function MilestoneForm({
  projectId,
  milestone,
}: {
  projectId: string;
  milestone?: Milestone;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [name, setName] = useState(milestone?.name ?? "");
  const [status, setStatus] = useState<Milestone["status"]>(
    milestone?.status ?? "not_started",
  );
  const [targetDate, setTargetDate] = useState(milestone?.target_date ?? "");
  const [completionPct, setCompletionPct] = useState(
    milestone?.completion_pct ?? 0,
  );
  // Content-enrichment P0 fields
  const [description, setDescription] = useState(milestone?.description ?? "");
  const [deliverable, setDeliverable] = useState(milestone?.deliverable ?? "");
  const [startDate, setStartDate] = useState(milestone?.start_date ?? "");
  const [baselineTargetDate, setBaselineTargetDate] = useState(
    milestone?.baseline_target_date ?? "",
  );
  const [actualDate, setActualDate] = useState(milestone?.actual_date ?? "");

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

    // Client-side validation — immediate feedback before the network round-trip.
    const clientResult = validateFields([
      { key: "name", value: name, message: "Milestone name is required" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const payload = {
      name,
      status,
      target_date: targetDate || null,
      completion_pct: Number(completionPct),
      // Content-enrichment P0 fields (optional/nullable)
      description: description || null,
      deliverable: deliverable || null,
      start_date: startDate || null,
      baseline_target_date: baselineTargetDate || null,
      actual_date: actualDate || null,
    };

    try {
      if (milestone) {
        await apiPatch(`/api/milestones/${milestone.id}`, payload);
        toast.success("Milestone updated");
      } else {
        await apiPost(`/api/projects/${projectId}/milestones`, payload);
        toast.success("Milestone created");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save milestone");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {topError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger">
          {topError}
        </div>
      )}

      {/* Title — prominent, borderless */}
      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Milestone name"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.name} />
      </div>

      {/* Section: Status & Schedule */}
      <FormSection title="Status & Schedule">
        <FormGrid>
          <div>
            <FieldLabel>Status</FieldLabel>
            <SelectInput
              value={status}
              onChange={(e) => setStatus(e.target.value as Milestone["status"])}
            >
              <option value="not_started">Not Started</option>
              <option value="on_track">On Track</option>
              <option value="at_risk">At Risk</option>
              <option value="delayed">Delayed</option>
              <option value="completed">Completed</option>
            </SelectInput>
            <FieldError message={fieldErrors.status} />
          </div>

          <div>
            <FieldLabel>Completion %</FieldLabel>
            <Input
              type="number"
              min={0}
              max={100}
              value={completionPct}
              onChange={(e) => setCompletionPct(Number(e.target.value))}
              placeholder="0"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.completion_pct} />
          </div>

          <div>
            <FieldLabel>Start Date</FieldLabel>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.start_date} />
          </div>

          <div>
            <FieldLabel>Target Date</FieldLabel>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.target_date} />
          </div>

          <div>
            <FieldLabel>Baseline Target Date</FieldLabel>
            <Input
              type="date"
              value={baselineTargetDate}
              onChange={(e) => setBaselineTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.baseline_target_date} />
          </div>

          <div>
            <FieldLabel>Actual Date</FieldLabel>
            <Input
              type="date"
              value={actualDate}
              onChange={(e) => setActualDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.actual_date} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Definition */}
      <FormSection title="Definition">
        <div>
          <FieldLabel>Description</FieldLabel>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Milestone narrative — what this milestone represents and why it matters."
          />
          <FieldError message={fieldErrors.description} />
        </div>

        <div>
          <FieldLabel>Deliverable</FieldLabel>
          <TextareaInput
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
            placeholder="WBS deliverable / acceptance output produced at this milestone."
          />
          <FieldError message={fieldErrors.deliverable} />
        </div>
      </FormSection>

      {/* Actions */}
      <FormActions>
        <Button type="button" variant="ghost" onClick={inspector.close} disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !name.trim()} className="w-full sm:w-auto h-11 sm:h-10">
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : milestone ? (
            "Save Changes"
          ) : (
            "Add Milestone"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
