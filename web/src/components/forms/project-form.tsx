"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";

// ── Data shape ────────────────────────────────────────────────────────────────
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
        "h-8 w-full rounded-md border border-border-subtle bg-canvas px-2.5 text-sm text-ink",
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
        "min-h-[72px] w-full rounded-md border border-border-subtle bg-canvas px-3 py-2 text-sm text-ink",
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
  const modal = useModal();
  const router = useRouter();

  const [code, setCode] = useState(project?.code ?? "");
  const [name, setName] = useState(project?.name ?? "");
  const [program, setProgram] = useState(project?.program ?? "");
  const [ragStatus, setRagStatus] = useState<Project["rag_status"]>(
    project?.rag_status ?? "not_started",
  );
  const [startDate, setStartDate] = useState(project?.start_date ?? "");
  const [targetDate, setTargetDate] = useState(project?.target_date ?? "");
  const [currency, setCurrency] = useState(project?.currency ?? "MYR");

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
      code: code || null,
      name,
      program: program || null,
      rag_status: ragStatus,
      start_date: startDate || null,
      target_date: targetDate || null,
      currency,
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

        modal.close();
        router.push(`/projects/${p.id}`);
      } else {
        await apiPatch(`/api/projects/${project!.id}`, payload);
        router.refresh();
        modal.close();
      }
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

      {/* Compact properties grid */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 pt-1">
        {/* Code */}
        <div>
          <FieldLabel>Code</FieldLabel>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="PROJ-001"
            className="h-8 text-sm"
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
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.program} />
        </div>

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

        {/* Currency */}
        <div>
          <FieldLabel>Currency</FieldLabel>
          <SelectInput
            value={currency}
            onChange={(e) => setCurrency(e.target.value)}
          >
            <option value="MYR">MYR</option>
            <option value="USD">USD</option>
            <option value="SGD">SGD</option>
            <option value="EUR">EUR</option>
            <option value="GBP">GBP</option>
            <option value="AUD">AUD</option>
          </SelectInput>
          <FieldError message={fieldErrors.currency} />
        </div>

        {/* Start Date */}
        <div>
          <FieldLabel>Start Date</FieldLabel>
          <Input
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            className="h-8 text-sm"
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
            className="h-8 text-sm"
          />
          <FieldError message={fieldErrors.target_date} />
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
          ) : mode === "create" ? (
            "Create Project"
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </form>
  );
}
