"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { DocumentForm } from "@/components/documents/document-form";
import { apiGet, type ApiError } from "@/lib/api-client";
import {
  EVIDENCE_RESULT_LABELS,
  EVIDENCE_TYPE_LABELS,
  evidenceResultTone,
  type EvidenceResult,
  type EvidenceType,
} from "@/lib/documents/evidence-labels";

/** One evidence row as GET /api/change-requests/:id/evidence returns it. */
export interface EvidenceItem {
  id: string;
  reference_id: string | null;
  title: string;
  evidence_type: string | null;
  evidence_result: string | null;
  tested_by_label: string | null;
  tested_at: string | null;
  evidence_note: string | null;
}

export interface EvidencePanelProps {
  changeRequestId: string;
  /** The change request's project; the attached document is filed under it. */
  projectId: string | null;
  /** Shown in the pre-filled document title, e.g. "CR-004". */
  referenceId?: string | null;
  /** False hides the attach button (viewers). The API enforces this regardless. */
  canAttach?: boolean;
}

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Test, UAT and deploy evidence attached to a change request (R-137). Stacked rows,
 * never a table, so it fits a phone. "Attach evidence" opens the document form
 * pre-filled with this change request.
 */
export function EvidencePanel({ changeRequestId, projectId, referenceId = null, canAttach = true }: EvidencePanelProps) {
  const inspector = useInspector();
  const [items, setItems] = useState<EvidenceItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    apiGet<EvidenceItem[]>(`/api/change-requests/${changeRequestId}/evidence`)
      .then((rows) => {
        if (live) setItems(rows ?? []);
      })
      .catch((err: ApiError) => {
        if (live) setError(err.message || "Could not load the evidence.");
      });
    return () => {
      live = false;
    };
  }, [changeRequestId]);

  function attach() {
    inspector.open(
      <DocumentForm
        evidenceFor={{ id: changeRequestId, reference_id: referenceId, title: "", project_id: projectId }}
      />,
      "Attach evidence",
    );
  }

  return (
    <section aria-labelledby={`evidence-${changeRequestId}`} className="mt-4 rounded-lg border border-border-subtle p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id={`evidence-${changeRequestId}`} className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          Test and UAT evidence
        </h3>
        {canAttach && (
          <Button variant="secondary" size="sm" className="h-11 shrink-0 sm:h-8" onClick={attach}>
            Attach evidence
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger-ink">
          {error}
        </p>
      )}
      {!error && items === null && (
        <p className="flex items-center gap-2 text-sm text-ink-muted">
          <Spinner size="sm" /> Loading evidence…
        </p>
      )}
      {!error && items !== null && items.length === 0 && (
        <p className="text-sm text-ink-muted">No evidence attached yet.</p>
      )}

      {items !== null && items.length > 0 && (
        <ul className="divide-y divide-border-subtle">
          {items.map((it) => (
            <li key={it.id} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center gap-2">
                {it.evidence_type && (
                  <Badge size="sm" tone="neutral">
                    {EVIDENCE_TYPE_LABELS[it.evidence_type as EvidenceType] ?? it.evidence_type}
                  </Badge>
                )}
                {it.evidence_result && (
                  <Badge size="sm" tone={evidenceResultTone(it.evidence_result)}>
                    {EVIDENCE_RESULT_LABELS[it.evidence_result as EvidenceResult] ?? it.evidence_result}
                  </Badge>
                )}
              </div>
              <Link
                href={`/documents?doc=${it.id}`}
                className="min-w-0 break-words text-sm font-medium text-accent underline underline-offset-2"
              >
                {it.reference_id ? `${it.reference_id} · ` : ""}
                {it.title}
              </Link>
              <p className="text-xs text-ink-secondary">
                {it.tested_by_label ? `Tested by ${it.tested_by_label}` : "Tester not recorded"} · {formatDate(it.tested_at)}
              </p>
              {it.evidence_note && <p className="whitespace-pre-wrap break-words text-xs text-ink-muted">{it.evidence_note}</p>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
