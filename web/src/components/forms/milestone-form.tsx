"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError, SelectInput } from "@/components/forms/project-form";

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
}

// ── MilestoneForm ─────────────────────────────────────────────────────────────
export function MilestoneForm({
  projectId,
  milestone,
}: {
  projectId: string;
  milestone?: Milestone;
}) {
  const modal = useModal();
  const router = useRouter();

  const [name, setName] = useState(milestone?.name ?? "");
  const [status, setStatus] = useState<Milestone["status"]>(
    milestone?.status ?? "not_started",
  );
  const [targetDate, setTargetDate] = useState(milestone?.target_date ?? "");
  const [completionPct, setCompletionPct] = useState(
    milestone?.completion_pct ?? 0,
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
      name,
      status,
      target_date: targetDate || null,
      completion_pct: Number(completionPct),
    };

    try {
      if (milestone) {
        await apiPatch(`/api/milestones/${milestone.id}`, payload);
      } else {
        await apiPost(`/api/projects/${projectId}/milestones`, payload);
      }
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

      {/* Compact 2-col grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
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
          <FieldLabel>Target Date</FieldLabel>
          <Input
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.target_date} />
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
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.completion_pct} />
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
        <Button type="button" variant="ghost" onClick={modal.close} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
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
      </div>
    </form>
  );
}
