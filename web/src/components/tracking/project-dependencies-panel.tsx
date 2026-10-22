"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { apiDelete, apiGet, apiPost, type ApiError } from "@/lib/api-client";
import { ragLabel, ragTone } from "@/lib/status";

type Kind = "delivery" | "resource" | "decision" | "risk";

const KIND_LABELS: Record<Kind, string> = {
  delivery: "Delivery",
  resource: "Resource",
  decision: "Decision",
  risk: "Risk",
};

interface OtherProject {
  id: string;
  code: string | null;
  name: string | null;
  rag_status: string | null;
}

interface DependencyRow {
  id: string;
  kind: Kind;
  note: string | null;
  linked_risk_id: string | null;
  direction: "depends_on" | "depended_on_by";
  other_project: OtherProject;
}

interface Contingency {
  contingent_on_red: boolean;
  chain: { id: string; code: string | null; name: string | null; rag_status: string | null }[];
  depth_capped: boolean;
}

interface ProjectOption {
  id: string;
  code: string | null;
  name: string | null;
}

interface RiskOption {
  id: string;
  reference_id: string | null;
  title: string;
}

const label = (p: { code: string | null; name: string | null }) => [p.code, p.name].filter(Boolean).join(" · ") || "Project";

/**
 * Cross-project dependencies of one project (R-147): what it depends on, who depends on
 * it, and a "contingent" note when something it depends on is declared red. Stacked rows,
 * never a table, so it fits a phone. The declared health of the project is never changed
 * here; the note is a suggestion.
 */
export function ProjectDependenciesPanel({ projectId }: { projectId: string }) {
  const [rows, setRows] = useState<DependencyRow[] | null>(null);
  const [contingency, setContingency] = useState<Contingency | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Bumped after every add/remove to re-run the load effect.
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let live = true;
    Promise.all([
      apiGet<DependencyRow[]>(`/api/projects/${projectId}/dependencies`),
      apiGet<Contingency>(`/api/projects/${projectId}/contingency`),
    ])
      .then(([deps, cont]) => {
        if (!live) return;
        setRows(deps ?? []);
        setContingency(cont ?? null);
        setError(null);
      })
      .catch((err: ApiError) => {
        if (live) setError(err.message || "Could not load the dependencies.");
      });
    return () => {
      live = false;
    };
  }, [projectId, version]);

  async function remove(id: string) {
    setBusyId(id);
    try {
      await apiDelete(`/api/projects/${projectId}/dependencies/${id}`);
      reload();
    } catch (err) {
      setError((err as ApiError).message || "Could not remove the dependency.");
    } finally {
      setBusyId(null);
    }
  }

  const redCulprit = contingency?.contingent_on_red ? contingency.chain[contingency.chain.length - 1] : null;

  return (
    <section aria-labelledby={`project-deps-${projectId}`} className="rounded-lg border border-border-subtle p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 id={`project-deps-${projectId}`} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Project dependencies
        </h2>
        {!adding && (
          <Button variant="secondary" size="sm" className="h-11 shrink-0 sm:h-8" onClick={() => setAdding(true)}>
            Add dependency
          </Button>
        )}
      </div>

      {redCulprit && (
        <p role="status" className="mb-3 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning-ink">
          Contingent on {label(redCulprit)}, which is delayed
          {contingency && contingency.chain.length > 2
            ? ` (via ${contingency.chain
                .slice(1, -1)
                .map((c) => c.code ?? c.name ?? "project")
                .join(" → ")})`
            : ""}
          . This project&apos;s own health is unchanged.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-2 text-sm text-danger-ink">
          {error}
        </p>
      )}
      {!error && rows === null && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner size="sm" /> Loading dependencies…
        </p>
      )}
      {!error && rows !== null && rows.length === 0 && !adding && (
        <p className="text-sm text-ink-muted">No project dependencies declared.</p>
      )}

      {rows !== null && rows.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-col gap-1.5 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge size="sm" tone="neutral">
                  {d.direction === "depends_on" ? "Depends on" : "Needed by"}
                </Badge>
                <Badge size="sm" tone="neutral">
                  {KIND_LABELS[d.kind] ?? d.kind}
                </Badge>
                {d.other_project.rag_status && (
                  <Badge size="sm" tone={ragTone(d.other_project.rag_status)}>
                    {ragLabel(d.other_project.rag_status)}
                  </Badge>
                )}
              </div>
              <Link
                href={`/projects/${d.other_project.id}`}
                className="min-w-0 break-words text-sm font-medium text-accent underline underline-offset-2"
              >
                {label(d.other_project)}
              </Link>
              {d.note && <p className="whitespace-pre-wrap break-words text-xs text-ink-muted">{d.note}</p>}
              {d.direction === "depends_on" && (
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-11 w-full sm:h-8 sm:w-auto"
                    disabled={busyId === d.id}
                    onClick={() => remove(d.id)}
                    aria-label={`Remove dependency on ${label(d.other_project)}`}
                  >
                    Remove
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddForm
          projectId={projectId}
          onCancel={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

function AddForm({
  projectId,
  onCancel,
  onAdded,
}: {
  projectId: string;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [risks, setRisks] = useState<RiskOption[]>([]);
  const [dependsOn, setDependsOn] = useState("");
  const [kind, setKind] = useState<Kind>("delivery");
  const [riskId, setRiskId] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<ProjectOption[]>(`/api/projects?limit=100`)
      .then((list) => {
        if (live) setProjects((list ?? []).filter((p) => p.id !== projectId));
      })
      .catch((err: ApiError) => live && setError(err.message || "Could not load the projects."));
    return () => {
      live = false;
    };
  }, [projectId]);

  // The linked risk must belong to this project or the one it depends on.
  useEffect(() => {
    let live = true;
    const ids = [projectId, ...(dependsOn ? [dependsOn] : [])];
    Promise.all(ids.map((id) => apiGet<RiskOption[]>(`/api/projects/${id}/risks?limit=100`)))
      .then((lists) => {
        if (live) setRisks(lists.flatMap((l) => l ?? []));
      })
      .catch(() => live && setRisks([]));
    return () => {
      live = false;
    };
  }, [projectId, dependsOn]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!dependsOn) {
      setError("Pick the project this one depends on.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiPost(`/api/projects/${projectId}/dependencies`, {
        depends_on_project_id: dependsOn,
        kind,
        linked_risk_id: riskId || null,
        note: note.trim() || null,
      });
      onAdded();
    } catch (err) {
      setError((err as ApiError).message || "Could not add the dependency.");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-3 flex flex-col gap-3 border-t border-border-subtle pt-3">
      <Field label="Depends on" required>
        {(a11y) => (
          <Select {...a11y} value={dependsOn} onChange={(e) => {
              setDependsOn(e.target.value);
              setRiskId(""); // the risk list changes with the project
            }} className="w-full">
            <option value="">Choose a project</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {label(p)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Kind" required>
        {(a11y) => (
          <Select {...a11y} value={kind} onChange={(e) => setKind(e.target.value as Kind)} className="w-full">
            {(Object.keys(KIND_LABELS) as Kind[]).map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Linked risk" optional>
        {(a11y) => (
          <Select {...a11y} value={riskId} onChange={(e) => setRiskId(e.target.value)} className="w-full">
            <option value="">No linked risk</option>
            {risks.map((r) => (
              <option key={r.id} value={r.id}>
                {[r.reference_id, r.title].filter(Boolean).join(" · ")}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="Note" optional>
        {(a11y) => <Input {...a11y} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      {error && (
        <p role="alert" className="text-sm text-danger-ink">
          {error}
        </p>
      )}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="h-11 w-full sm:h-9 sm:w-auto" disabled={saving}>
          {saving ? "Adding…" : "Add dependency"}
        </Button>
        <Button type="button" variant="secondary" className="h-11 w-full sm:h-9 sm:w-auto" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
