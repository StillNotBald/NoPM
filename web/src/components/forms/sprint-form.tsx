"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiGet, type ApiError } from "@/lib/api-client";
import { z } from "zod";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";

/** Minimal project shape for the project picker — mirrors program-form's owner picker. */
interface ProjectOption {
  id: string;
  code: string | null;
  name: string;
}

const sprintClientSchema = z.object({
  project_id: z.string().min(1, "Project is required"),
  name: z.string().min(1, "Sprint name is required"),
  start_date: z.string().min(1, "Start date is required"),
  end_date: z.string().min(1, "End date is required"),
});

/**
 * Create-only sprint form (L-17). Sprints are created `state: 'planned'` via
 * POST /api/sprints; the start/close transitions happen from
 * `SprintTransitionActions` on the sprint detail card, never here.
 */
export function SprintForm({ defaultProjectId }: { defaultProjectId?: string }) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [projects, setProjects] = useState<ProjectOption[]>([]);
  useEffect(() => {
    apiGet<ProjectOption[]>("/api/projects?limit=100")
      .then((list) => setProjects(list ?? []))
      .catch(() => {
        /* non-critical — picker just stays empty */
      });
  }, []);

  const [projectId, setProjectId] = useState(defaultProjectId ?? "");
  const [name, setName] = useState("");
  const [goal, setGoal] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

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

    const clientResult = sprintClientSchema.safeParse({
      project_id: projectId,
      name,
      start_date: startDate,
      end_date: endDate,
    });
    if (!clientResult.success) {
      const map: Record<string, string> = {};
      for (const issue of clientResult.error.issues) {
        const field = issue.path[0] as string;
        if (!map[field]) map[field] = issue.message;
      }
      setFieldErrors(map);
      return;
    }

    setSaving(true);
    try {
      const sprint = await apiPost<{ id: string }>("/api/sprints", {
        project_id: projectId,
        name,
        goal: goal || null,
        start_date: startDate,
        end_date: endDate,
      });
      toast.success("Sprint created");
      inspector.close();
      router.push(`/sprints?sprint=${sprint.id}`);
      router.refresh();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to create sprint");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {topError && (
        <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger">{topError}</div>
      )}

      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Sprint name"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.name} />
      </div>

      <FormSection title="Sprint">
        <FormGrid>
          <div>
            <FieldLabel required>Project</FieldLabel>
            <SelectInput value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">— Select a project —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.code ? `${p.code} — ${p.name}` : p.name}
                </option>
              ))}
            </SelectInput>
            <FieldError message={fieldErrors.project_id} />
          </div>
          <div />
          <div>
            <FieldLabel required>Start date</FieldLabel>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              required
            />
            <FieldError message={fieldErrors.start_date} />
          </div>
          <div>
            <FieldLabel required>End date</FieldLabel>
            <Input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              required
            />
            <FieldError message={fieldErrors.end_date} />
          </div>
        </FormGrid>
      </FormSection>

      <FormSection title="Goal">
        <div>
          <TextareaInput
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="What this sprint is aiming to deliver"
          />
          <FieldError message={fieldErrors.goal} />
        </div>
      </FormSection>

      <FormActions>
        <Button
          type="button"
          variant="ghost"
          onClick={inspector.close}
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={saving || !name.trim() || !projectId || !startDate || !endDate}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Creating…
            </>
          ) : (
            "Create Sprint"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
