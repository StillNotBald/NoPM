"use client";

import { useState } from "react";
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
}

// ── Shared field helpers ──────────────────────────────────────────────────────
export function FieldLabel({
  children,
  required,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="mb-0.5 block text-[11px] font-semibold uppercase tracking-wider text-ink-muted">
      {children}
      {required && <span className="ml-0.5 text-danger">*</span>}
    </label>
  );
}

export function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <p className="mt-0.5 text-[11px] text-danger">{message}</p>;
}

export function SelectInput({
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-11 sm:h-10 w-full rounded-md border border-border-subtle bg-canvas px-2.5 text-base sm:text-sm text-ink",
        "focus:outline-none focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
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
        "placeholder:text-ink-muted focus:outline-none",
        "focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-accent/30",
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
      { key: "name", value: name, message: "Project name is required" },
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
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save project");
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

      {/* Title — the only visually prominent field */}
      <div>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Project name"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.name} />
      </div>

      {/* Section: Identity */}
      <FormSection title="Identity">
        <FormGrid>
          {/* Code */}
          <div>
            <FieldLabel>Code</FieldLabel>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="PROJ-001"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.code} />
          </div>

          {/* Program */}
          <div>
            <FieldLabel>Program</FieldLabel>
            <Input
              value={program}
              onChange={(e) => setProgram(e.target.value)}
              placeholder="e.g. Digital Transformation"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.program} />
          </div>

          {/* Phase */}
          <div>
            <FieldLabel>Phase</FieldLabel>
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
            <FieldError message={fieldErrors.phase} />
          </div>

          {/* Currency */}
          <div>
            <FieldLabel>Currency</FieldLabel>
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
            <FieldError message={fieldErrors.currency} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Status & Schedule */}
      <FormSection title="Status & Schedule">
        <FormGrid>
          {/* RAG Status */}
          <div>
            <FieldLabel>RAG Status</FieldLabel>
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
            <FieldError message={fieldErrors.rag_status} />
          </div>

          {/* Placeholder to keep grid aligned */}
          <div />

          {/* Start Date */}
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

          {/* Target Date */}
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

          {/* Baseline Start Date */}
          <div>
            <FieldLabel>Baseline Start</FieldLabel>
            <Input
              type="date"
              value={baselineStartDate}
              onChange={(e) => setBaselineStartDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.baseline_start_date} />
          </div>

          {/* Baseline Target Date */}
          <div>
            <FieldLabel>Baseline Target</FieldLabel>
            <Input
              type="date"
              value={baselineTargetDate}
              onChange={(e) => setBaselineTargetDate(e.target.value)}
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.baseline_target_date} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Ownership */}
      <FormSection title="Ownership">
        <FormGrid>
          {/* Sponsor */}
          <div>
            <FieldLabel>Sponsor</FieldLabel>
            <Input
              value={sponsor}
              onChange={(e) => setSponsor(e.target.value)}
              placeholder="e.g. Jane Doe, CFO"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.sponsor} />
          </div>

          {/* Project Manager */}
          <div>
            <FieldLabel>Project Manager</FieldLabel>
            <Input
              value={projectManager}
              onChange={(e) => setProjectManager(e.target.value)}
              placeholder="e.g. Wei Jie Tan"
              className="h-11 sm:h-10 text-base sm:text-sm"
            />
            <FieldError message={fieldErrors.project_manager} />
          </div>
        </FormGrid>
      </FormSection>

      {/* Section: Charter — long-form narrative fields */}
      <FormSection title="Charter">
        <div>
          <FieldLabel>Objective</FieldLabel>
          <TextareaInput
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            placeholder="Project purpose / objective"
          />
          <FieldError message={fieldErrors.objective} />
        </div>

        <div>
          <FieldLabel>Business Case</FieldLabel>
          <TextareaInput
            value={businessCase}
            onChange={(e) => setBusinessCase(e.target.value)}
            placeholder="Business case / justification"
          />
          <FieldError message={fieldErrors.business_case} />
        </div>

        <div>
          <FieldLabel>Scope Summary</FieldLabel>
          <TextareaInput
            value={scopeSummary}
            onChange={(e) => setScopeSummary(e.target.value)}
            placeholder="High-level scope"
          />
          <FieldError message={fieldErrors.scope_summary} />
        </div>

        <div>
          <FieldLabel>Health Commentary</FieldLabel>
          <TextareaInput
            value={healthCommentary}
            onChange={(e) => setHealthCommentary(e.target.value)}
            placeholder='RAG narrative — one-line "why is it amber?"'
          />
          <FieldError message={fieldErrors.health_commentary} />
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
