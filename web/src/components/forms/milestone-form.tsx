"use client";

import { STALE_RECORD_MESSAGE } from "./messages";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { Field, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
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
  // Optimistic concurrency (R-90) — present on any record loaded from the
  // API; carried back on PATCH as expected_updated_at when editing.
  updated_at?: string | null;
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

  const [openTasksPrompt, setOpenTasksPrompt] = useState(false);
  const [saving, setSaving] = useState(false);
  const [topError, setTopError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function applyApiError(err: ApiError) {
    setTopError(err.message ?? "An error occurred.");
    const map: Record<string, string> = {};
    for (const f of err.fields ?? []) map[f.field] = f.message;
    setFieldErrors(map);
  }

  async function handleSubmit(e: React.FormEvent | null, confirmOpenTasks = false) {
    e?.preventDefault();
    setOpenTasksPrompt(false);
    setTopError(null);
    setFieldErrors({});

    // Client-side validation — immediate feedback before the network round-trip.
    const clientResult = validateFields([
      { key: "name", value: name.trim(), message: "Milestone name is required" },
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
      // Optimistic concurrency (R-90) — only meaningful (and only sent) on
      // an edit of an existing record; a create has nothing to be stale.
      ...(confirmOpenTasks ? { confirm_open_tasks: true } : {}),
      ...(milestone?.updated_at ? { expected_updated_at: milestone.updated_at } : {}),
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
      const apiErr = err as ApiError;
      if (apiErr.status === 412) {
        setTopError(STALE_RECORD_MESSAGE);
        toast.error(STALE_RECORD_MESSAGE);
      } else if (apiErr.status === 422 && apiErr.code === "open_tasks") {
        setTopError(apiErr.message);
        setOpenTasksPrompt(true);
        setSaving(false);
      } else {
        applyApiError(apiErr);
        toast.error(apiErr.message ?? "Failed to save milestone");
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />
      {openTasksPrompt && (
        <div>
          <Button type="button" variant="secondary" disabled={saving} onClick={() => handleSubmit(null, true)} className="h-11 sm:h-10">
            Complete anyway
          </Button>
        </div>
      )}

      {/* Title — prominent, borderless */}
      <TitleField
        label="Milestone name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Milestone name"
        required
        error={fieldErrors.name}
      />

      {/* Section: Status & Schedule */}
      <FormSection title="Status & Schedule">
        <FormGrid>
          <Field label="Status" error={fieldErrors.status}>
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
          </Field>

          <Field label="Completion %" error={fieldErrors.completion_pct}>
            <Input
              type="number"
              min={0}
              max={100}
              value={completionPct}
              onChange={(e) => setCompletionPct(Number(e.target.value))}
              placeholder="0"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Start Date" error={fieldErrors.start_date}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Target Date" error={fieldErrors.target_date}>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Baseline Target Date" error={fieldErrors.baseline_target_date}>
            <Input
              type="date"
              value={baselineTargetDate}
              onChange={(e) => setBaselineTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          <Field label="Actual Date" error={fieldErrors.actual_date}>
            <Input
              type="date"
              value={actualDate}
              onChange={(e) => setActualDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Definition */}
      <FormSection title="Definition">
        <Field label="Description" error={fieldErrors.description}>
          <TextareaInput
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this milestone is and why it matters."
          />
        </Field>

        <Field label="Deliverable" error={fieldErrors.deliverable}>
          <TextareaInput
            value={deliverable}
            onChange={(e) => setDeliverable(e.target.value)}
            placeholder="Deliverable or acceptance output."
          />
        </Field>
      </FormSection>

      {/* Actions */}
      <FormActions>
        <Button type="button" variant="ghost" onClick={inspector.close} disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving} className="w-full sm:w-auto h-11 sm:h-10">
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
