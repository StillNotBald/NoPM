"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { FieldLabel, FieldError, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { FormShell, FormSection, FormGrid, FormActions } from "@/components/forms/form-shell";
import { createDecisionSchema } from "@/app/api/decisions/_schema";

// ── Local types ───────────────────────────────────────────────────────────────

export type DecisionStatus = "proposed" | "accepted" | "superseded" | "rejected";

export interface Decision {
  id: string;
  workspace_id: string;
  project_id: string | null;
  reference_id: string | null;
  title: string;
  context: string | null;
  options: string | null;
  decision: string | null;
  rationale: string | null;
  status: DecisionStatus;
  decided_by: string | null;
  decided_by_label: string | null;
  decided_at: string | null;
  supersedes: string | null;
  created_at: string;
  updated_at: string;
}

type Project = { id: string; name: string };

// ── DecisionForm ──────────────────────────────────────────────────────────────

export function DecisionForm({
  projects,
  decision,
}: {
  projects: Project[];
  decision?: Decision;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [projectId, setProjectId] = useState(
    decision?.project_id ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState(decision?.title ?? "");
  const [context, setContext] = useState(decision?.context ?? "");
  const [showContext, setShowContext] = useState(
    !!(decision?.context && decision.context.trim().length > 0),
  );
  const [options, setOptions] = useState(decision?.options ?? "");
  const [showOptions, setShowOptions] = useState(
    !!(decision?.options && decision.options.trim().length > 0),
  );
  const [decisionText, setDecisionText] = useState(decision?.decision ?? "");
  const [rationale, setRationale] = useState(decision?.rationale ?? "");
  const [showRationale, setShowRationale] = useState(
    !!(decision?.rationale && decision.rationale.trim().length > 0),
  );
  const [status, setStatus] = useState<DecisionStatus>(decision?.status ?? "accepted");
  const [decidedAt, setDecidedAt] = useState(
    decision?.decided_at?.slice(0, 10) ?? "",
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

    // Client-side validation — reuse the server schema's safeParse for
    // immediate inline errors before the network round-trip.
    const clientResult = createDecisionSchema.safeParse({
      title: title.trim(),
      context: context.trim() || null,
      options: options.trim() || null,
      decision: decisionText.trim() || null,
      rationale: rationale.trim() || null,
      status,
      decided_at: decidedAt || null,
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

    const payload = {
      title: title.trim(),
      context: context.trim() || null,
      options: options.trim() || null,
      decision: decisionText.trim() || null,
      rationale: rationale.trim() || null,
      status,
      decided_at: decidedAt || null,
    };

    try {
      if (decision) {
        await apiPatch(`/api/decisions/${decision.id}`, payload);
        toast.success("Decision updated");
      } else {
        await apiPost(`/api/projects/${projectId}/decisions`, payload);
        toast.success("Decision recorded");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save decision");
      setSaving(false);
    }
  }

  return (
    <FormShell
      main={
        <form onSubmit={handleSubmit} className="space-y-5">
          {topError && (
            <div className="rounded-md bg-danger/10 px-3 py-2.5 text-sm text-danger-ink">
              {topError}
            </div>
          )}

          {/* Title — prominent */}
          <div>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Decision title"
              required
              className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
            />
            <FieldError message={fieldErrors.title} />
          </div>

          {/* Properties section */}
          <FormSection title="Properties">
            <FormGrid>
              {/* Project — only shown when creating */}
              {!decision && (
                <div className="col-span-2">
                  <FieldLabel>Project</FieldLabel>
                  <SelectInput
                    value={projectId}
                    onChange={(e) => setProjectId(e.target.value)}
                  >
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </SelectInput>
                  <FieldError message={fieldErrors.project_id} />
                </div>
              )}

              {/* Status */}
              <div>
                <FieldLabel>Status</FieldLabel>
                <SelectInput
                  value={status}
                  onChange={(e) => setStatus(e.target.value as DecisionStatus)}
                >
                  <option value="proposed">Proposed</option>
                  <option value="accepted">Accepted</option>
                  <option value="superseded">Superseded</option>
                  <option value="rejected">Rejected</option>
                </SelectInput>
                <FieldError message={fieldErrors.status} />
              </div>

              {/* Decided Date */}
              <div>
                <FieldLabel>Decision Date</FieldLabel>
                <Input
                  type="date"
                  value={decidedAt}
                  onChange={(e) => setDecidedAt(e.target.value)}
                  className="h-11 sm:h-10 text-base sm:text-sm"
                />
                <FieldError message={fieldErrors.decided_at} />
              </div>
            </FormGrid>
          </FormSection>

          {/* Content section */}
          <FormSection title="Content">
            {/* Decision text — required */}
            <div>
              <FieldLabel>The Decision</FieldLabel>
              <TextareaInput
                value={decisionText}
                onChange={(e) => setDecisionText(e.target.value)}
                placeholder="State the chosen course of action…"
                rows={2}
              />
              <FieldError message={fieldErrors.decision} />
            </div>

            {/* Context — progressive disclosure */}
            {showContext ? (
              <div>
                <FieldLabel>Context</FieldLabel>
                <TextareaInput
                  value={context}
                  onChange={(e) => setContext(e.target.value)}
                  placeholder="Background and situational context…"
                  rows={2}
                />
                <FieldError message={fieldErrors.context} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowContext(true)}
                className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
              >
                + Add context
              </button>
            )}

            {/* Options — progressive disclosure */}
            {showOptions ? (
              <div>
                <FieldLabel>Options Considered</FieldLabel>
                <TextareaInput
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                  placeholder="List the alternatives that were evaluated…"
                  rows={3}
                />
                <FieldError message={fieldErrors.options} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowOptions(true)}
                className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
              >
                + Add options considered
              </button>
            )}

            {/* Rationale — progressive disclosure */}
            {showRationale ? (
              <div>
                <FieldLabel>Rationale</FieldLabel>
                <TextareaInput
                  value={rationale}
                  onChange={(e) => setRationale(e.target.value)}
                  placeholder="Why this option was chosen over the alternatives…"
                  rows={2}
                />
                <FieldError message={fieldErrors.rationale} />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowRationale(true)}
                className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
              >
                + Add rationale
              </button>
            )}
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
              disabled={saving || !title.trim()}
              className="w-full sm:w-auto h-11 sm:h-10"
            >
              {saving ? (
                <>
                  <Spinner size="sm" className="mr-2" />
                  Saving…
                </>
              ) : decision ? (
                "Save Changes"
              ) : (
                "Add Decision"
              )}
            </Button>
          </FormActions>
        </form>
      }
    />
  );
}
