"use client";

import { cloneElement, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { validateFields } from "@/lib/forms/validate";
import { FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";

// ── Data shape ────────────────────────────────────────────────────────────────
export type ProjectPhase =
  | "initiation"
  | "planning"
  | "execution"
  | "monitoring"
  | "closing";

export interface Project {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  program: string | null;
  rag_status: "not_started" | "red" | "amber" | "green" | "complete";
  completion_pct: number;
  start_date: string | null;
  target_date: string | null;
  currency: string;
  is_locked: boolean;
  lock_reason: string | null;
  // ── Content enrichment (0008): PMBOK charter + baseline pair + phase ──────
  // Optional so callers that select only the base columns still satisfy the
  // type; the form falls back to safe defaults when a field is absent.
  business_case?: string | null;
  objective?: string | null;
  scope_summary?: string | null;
  sponsor?: string | null;
  project_manager?: string | null;
  phase?: ProjectPhase | null;
  health_commentary?: string | null;
  baseline_start_date?: string | null;
  baseline_target_date?: string | null;
  // Optimistic concurrency (R-90) — present on any record loaded from the
  // API; carried back on PATCH as expected_updated_at when editing.
  updated_at?: string | null;
}

// ── Shared field helpers ──────────────────────────────────────────────────────
//
// Prefer <Field> over a bare FieldLabel: it wires label → control (`htmlFor`/`id`
// via useId), `aria-invalid` and `aria-describedby` → the inline error, so every
// form control has an accessible name and an announced error. FieldLabel and
// FieldError stay exported (with optional `htmlFor` / `id`) for callers that lay
// out a control by hand.
export function FieldLabel({
  children,
  required,
  htmlFor,
  id,
}: {
  children: React.ReactNode;
  required?: boolean;
  /** id of the control this label names. */
  htmlFor?: string;
  /** For `aria-labelledby` on a group of controls this label names. */
  id?: string;
}) {
  return (
    <label
      id={id}
      htmlFor={htmlFor}
      className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted"
    >
      {children}
      {required && (
        <span className="ml-0.5 text-danger-ink" aria-hidden>
          *
        </span>
      )}
    </label>
  );
}

export function FieldError({ message, id }: { message?: string; id?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-0.5 text-xs text-danger-ink">
      {message}
    </p>
  );
}

/** Top-of-form error banner; announced to assistive tech when it appears. */
export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink">
      {message}
    </div>
  );
}

type ControlA11yProps = {
  id?: string;
  "aria-invalid"?: React.AriaAttributes["aria-invalid"];
  "aria-describedby"?: string;
  "aria-required"?: React.AriaAttributes["aria-required"];
};

/**
 * Label + control + hint + error, wired together. The single child must be a
 * form control that forwards `id` and aria props to its native element
 * (Input, SelectInput, TextareaInput all do). An `id` already on the child is
 * kept, so the label can still target a control the caller identifies itself.
 */
export function Field({
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  label: React.ReactNode;
  required?: boolean;
  error?: string;
  hint?: React.ReactNode;
  className?: string;
  children: React.ReactElement<ControlA11yProps>;
}) {
  const autoId = useId();
  const id = children.props.id ?? autoId;
  const errorId = error ? `${id}-error` : undefined;
  const hintId = hint ? `${id}-hint` : undefined;
  const describedBy =
    [children.props["aria-describedby"], hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={className}>
      <FieldLabel htmlFor={id} required={required}>
        {label}
      </FieldLabel>
      {cloneElement(children, {
        id,
        "aria-invalid": error ? true : children.props["aria-invalid"],
        "aria-describedby": describedBy,
        "aria-required": required ? true : children.props["aria-required"],
      })}
      {hint && (
        <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
          {hint}
        </p>
      )}
      <FieldError id={errorId} message={error} />
    </div>
  );
}

/**
 * The borderless, prominent first field of a create/edit form. Its visible
 * "label" is the placeholder, so the accessible name comes from `label`
 * (aria-label); the error is tied to the input like any other field.
 */
export function TitleField({
  label,
  error,
  className,
  id: idProp,
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "aria-label"> & {
  label: string;
  error?: string;
}) {
  const autoId = useId();
  const id = idProp ?? autoId;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <div>
      <Input
        id={id}
        aria-label={label}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={cn(
          "rounded-none border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted focus-visible:border-border-strong",
          className,
        )}
        {...props}
      />
      <FieldError id={errorId} message={error} />
    </div>
  );
}

export function SelectInput({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 sm:h-10 w-full rounded-md border border-border-subtle bg-canvas px-2.5 text-base sm:text-sm text-ink",
        "focus-ring focus-visible:border-accent",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TextareaInput({
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "min-h-[72px] w-full rounded-md border border-border-subtle bg-canvas px-3 py-2 text-base sm:text-sm text-ink",
        "placeholder:text-ink-muted focus-ring focus-visible:border-accent",
        "disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

// ── Date helper ───────────────────────────────────────────────────────────────
function addDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

// ── ProjectForm ───────────────────────────────────────────────────────────────
export function ProjectForm({
  mode,
  project,
  scaffold,
}: {
  mode: "create" | "edit";
  project?: Project;
  scaffold?: boolean;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [code, setCode] = useState(project?.code ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [program, setProgram] = useState(project?.program ?? "");
  const [ragStatus, setRagStatus] = useState<Project["rag_status"]>(
    project?.rag_status ?? "not_started",
  );
  const [startDate, setStartDate] = useState(project?.start_date ?? "");
  const [targetDate, setTargetDate] = useState(project?.target_date ?? "");
  const [currency, setCurrency] = useState(project?.currency ?? "USD");

  // ── Content enrichment (0008): PMBOK charter + baseline pair + phase ────────
  const [phase, setPhase] = useState<ProjectPhase>(project?.phase ?? "planning");
  const [sponsor, setSponsor] = useState(project?.sponsor ?? "");
  const [projectManager, setProjectManager] = useState(
    project?.project_manager ?? "",
  );
  const [objective, setObjective] = useState(project?.objective ?? "");
  const [businessCase, setBusinessCase] = useState(project?.business_case ?? "");
  const [scopeSummary, setScopeSummary] = useState(project?.scope_summary ?? "");
  const [healthCommentary, setHealthCommentary] = useState(
    project?.health_commentary ?? "",
  );
  const [baselineStartDate, setBaselineStartDate] = useState(
    project?.baseline_start_date ?? "",
  );
  const [baselineTargetDate, setBaselineTargetDate] = useState(
    project?.baseline_target_date ?? "",
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

    // Client-side validation — immediate feedback before the network round-trip.
    const clientResult = validateFields([
      { key: "name", value: name.trim(), message: "Project name is required" },
    ]);
    if (!clientResult.ok) {
      setFieldErrors(clientResult.errors);
      return;
    }

    setSaving(true);

    const payload = {
      code: code || null,
      name,
      program: program || null,
      rag_status: ragStatus,
      start_date: startDate || null,
      target_date: targetDate || null,
      currency,
      // ── Content enrichment (0008) ──────────────────────────────────────────
      phase,
      sponsor: sponsor || null,
      project_manager: projectManager || null,
      objective: objective || null,
      business_case: businessCase || null,
      scope_summary: scopeSummary || null,
      health_commentary: healthCommentary || null,
      baseline_start_date: baselineStartDate || null,
      baseline_target_date: baselineTargetDate || null,
      // Optimistic concurrency (R-90) — only meaningful (and only sent) on
      // an edit of an existing record; a create has nothing to be stale.
      ...(mode === "edit" && project?.updated_at
        ? { expected_updated_at: project.updated_at }
        : {}),
    };

    try {
      if (mode === "create") {
        const p = await apiPost<Project>("/api/projects", payload);

        if (scaffold) {
          const milestones: [string, number][] = [
            ["Design Closure", 30],
            ["Build & UAT", 90],
            ["Cutover & Closure", 150],
          ];
          for (const [mName, daysOffset] of milestones) {
            await apiPost(`/api/projects/${p.id}/milestones`, {
              name: mName,
              target_date: addDays(daysOffset),
              status: "not_started",
            });
          }
        }

        toast.success("Project created");
        inspector.close();
        router.push(`/projects/${p.id}`);
      } else {
        await apiPatch(`/api/projects/${project!.id}`, payload);
        toast.success("Project updated");
        router.refresh();
        inspector.close();
      }
    } catch (err) {
      const apiErr = err as ApiError;
      if (apiErr.status === 412) {
        setTopError("This record changed since you opened it. Reload to see the latest.");
        toast.error("This record changed since you opened it. Reload to see the latest.");
      } else {
        applyApiError(apiErr);
        toast.error(apiErr.message ?? "Failed to save project");
      }
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <FormError message={topError} />

      {/* Title — the only visually prominent field */}
      <TitleField
        label="Project name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Project name"
        required
        error={fieldErrors.name}
      />

      {/* Section: Identity */}
      <FormSection title="Identity">
        <FormGrid>
          {/* Code */}
          <Field label="Code" error={fieldErrors.code}>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PROJ-001"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Program */}
          <Field label="Program" error={fieldErrors.program}>
            <Input
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              placeholder="e.g. Digital Transformation"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Phase */}
          <Field label="Phase" error={fieldErrors.phase}>
            <SelectInput
              value={phase}
              onChange={(e) => setPhase(e.target.value as ProjectPhase)}
            >
              <option value="initiation">Initiation</option>
              <option value="planning">Planning</option>
              <option value="execution">Execution</option>
              <option value="monitoring">Monitoring</option>
              <option value="closing">Closing</option>
            </SelectInput>
          </Field>

          {/* Currency */}
          <Field label="Currency" error={fieldErrors.currency}>
            <SelectInput
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              <option value="USD">USD</option>
              <option value="SGD">SGD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
              <option value="AUD">AUD</option>
            </SelectInput>
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Status & Schedule */}
      <FormSection title="Status & Schedule">
        <FormGrid>
          {/* RAG Status */}
          <Field label="RAG Status" error={fieldErrors.rag_status}>
            <SelectInput
              value={ragStatus}
              onChange={(e) => setRagStatus(e.target.value as Project["rag_status"])}
            >
              <option value="not_started">Not Started</option>
              <option value="green">Green</option>
              <option value="amber">Amber</option>
              <option value="red">Red</option>
              <option value="complete">Complete</option>
            </SelectInput>
          </Field>

          {/* Placeholder to keep grid aligned */}
          <div />

          {/* Start Date */}
          <Field label="Start Date" error={fieldErrors.start_date}>
            <Input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Target Date */}
          <Field label="Target Date" error={fieldErrors.target_date}>
            <Input
              type="date"
              value={targetDate}
              onChange={(e) => setTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Baseline Start Date */}
          <Field label="Baseline Start" error={fieldErrors.baseline_start_date}>
            <Input
              type="date"
              value={baselineStartDate}
              onChange={(e) => setBaselineStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Baseline Target Date */}
          <Field label="Baseline Target" error={fieldErrors.baseline_target_date}>
            <Input
              type="date"
              value={baselineTargetDate}
              onChange={(e) => setBaselineTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Ownership */}
      <FormSection title="Ownership">
        <FormGrid>
          {/* Sponsor */}
          <Field label="Sponsor" error={fieldErrors.sponsor}>
            <Input
              value={sponsor}
              onChange={(e) => setSponsor(e.target.value)}
              placeholder="e.g. Jane Doe, CFO"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>

          {/* Project Manager */}
          <Field label="Project Manager" error={fieldErrors.project_manager}>
            <Input
              value={projectManager}
              onChange={(e) => setProjectManager(e.target.value)}
              placeholder="e.g. Wei Jie Tan"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
          </Field>
        </FormGrid>
      </FormSection>

      {/* Section: Charter — long-form narrative fields */}
      <FormSection title="Charter">
        <Field label="Objective" error={fieldErrors.objective}>
          <TextareaInput
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Project purpose / objective"
          />
        </Field>

        <Field label="Business Case" error={fieldErrors.business_case}>
          <TextareaInput
            value={businessCase}
            onChange={(e) => setBusinessCase(e.target.value)}
            placeholder="Business case / justification"
          />
        </Field>

        <Field label="Scope Summary" error={fieldErrors.scope_summary}>
          <TextareaInput
            value={scopeSummary}
            onChange={(e) => setScopeSummary(e.target.value)}
            placeholder="High-level scope"
          />
        </Field>

        <Field label="Health Commentary" error={fieldErrors.health_commentary}>
          <TextareaInput
            value={healthCommentary}
            onChange={(e) => setHealthCommentary(e.target.value)}
            placeholder='RAG narrative — one-line "why is it amber?"'
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
          ) : mode === "create" ? (
            "Create Project"
          ) : (
            "Save Changes"
          )}
        </Button>
      </FormActions>
    </form>
  );
}
