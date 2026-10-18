"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import { Field, FormError, TitleField, SelectInput, TextareaInput } from "@/components/forms/project-form";
import { createDocumentSchema } from "@/app/api/documents/_schema";
import {
  EVIDENCE_RESULTS,
  EVIDENCE_RESULT_LABELS,
  EVIDENCE_TYPES,
  EVIDENCE_TYPE_LABELS,
} from "@/lib/documents/evidence-labels";

// ── Local Document type (decoupled from docs-data files) ──────────────────────

export type DocStatus = "draft" | "in_review" | "approved" | "archived";
export type DocType =
  | "charter"
  | "plan"
  | "raid"
  | "status_report"
  | "change_request"
  | "minutes"
  | "spec"
  | "other";

export interface Document {
  id: string;
  workspace_id: string;
  project_id: string | null;
  reference_id: string | null;
  folder: string;
  title: string;
  doc_type: DocType;
  status: DocStatus;
  version: number;
  summary: string | null;
  body: string | null;
  external_url: string | null;
  owner_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // File attachment columns (added in migration 20260608000016)
  storage_path?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  file_size?: number | null;
  // Evidence columns (migration 20261018000094). A document is evidence only when change_request_id is set.
  change_request_id?: string | null;
  evidence_type?: string | null;
  evidence_result?: string | null;
  tested_by_label?: string | null;
  tested_at?: string | null;
  evidence_note?: string | null;
}

/** The change request a new document is being attached to as evidence. */
export type EvidenceTarget = { id: string; reference_id: string | null; title: string; project_id: string | null };

const DOC_TYPE_OPTIONS: { value: DocType; label: string }[] = [
  { value: "charter", label: "Charter" },
  { value: "plan", label: "Plan" },
  { value: "raid", label: "RAID Log" },
  { value: "status_report", label: "Status Report" },
  { value: "change_request", label: "Change Request" },
  { value: "minutes", label: "Meeting Minutes" },
  { value: "spec", label: "Specification" },
  { value: "other", label: "Other" },
];

const STATUS_OPTIONS: { value: DocStatus; label: string }[] = [
  { value: "draft", label: "Draft" },
  { value: "in_review", label: "In Review" },
  { value: "approved", label: "Approved" },
  { value: "archived", label: "Archived" },
];

const FOLDER_SUGGESTIONS = [
  "General",
  "Charter",
  "RAID",
  "Status Reports",
  "Change Control",
  "Minutes",
  "Specs",
];

type Project = { id: string; name: string };

// ── DocumentForm ──────────────────────────────────────────────────────────────

export function DocumentForm({
  document,
  projects,
  defaultProjectId,
  defaultFolder,
  evidenceFor,
}: {
  document?: Document;
  projects?: Project[];
  defaultProjectId?: string;
  defaultFolder?: string;
  /** Pre-fills the form to attach this document as evidence for a change request. */
  evidenceFor?: EvidenceTarget;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = useState(
    document?.title ?? (evidenceFor ? `Evidence for ${evidenceFor.reference_id ?? "change request"}` : ""),
  );
  const [docType, setDocType] = useState<DocType>(document?.doc_type ?? "other");
  const [status, setStatus] = useState<DocStatus>(document?.status ?? "draft");
  const [folder, setFolder] = useState(
    document?.folder ?? defaultFolder ?? (evidenceFor ? "Change Control" : "General"),
  );
  const [projectId, setProjectId] = useState(
    document?.project_id ?? defaultProjectId ?? evidenceFor?.project_id ?? "",
  );
  const [summary, setSummary] = useState(document?.summary ?? "");
  const [showSummary, setShowSummary] = useState(
    !!(document?.summary && document.summary.trim().length > 0),
  );
  const [body, setBody] = useState(document?.body ?? "");
  const [showBody, setShowBody] = useState(
    !!(document?.body && document.body.trim().length > 0),
  );
  const [externalUrl, setExternalUrl] = useState(document?.external_url ?? "");

  // Evidence: shown when the document is (or is about to be) linked to a change request.
  const changeRequestId = document?.change_request_id ?? evidenceFor?.id ?? null;
  const [evidenceType, setEvidenceType] = useState(document?.evidence_type ?? (evidenceFor ? "test_result" : ""));
  const [evidenceResult, setEvidenceResult] = useState(document?.evidence_result ?? "");
  const [testedBy, setTestedBy] = useState(document?.tested_by_label ?? "");
  const [testedAt, setTestedAt] = useState(document?.tested_at ? document.tested_at.slice(0, 10) : "");
  const [evidenceNote, setEvidenceNote] = useState(document?.evidence_note ?? "");

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
    // Evidence fields go only with a linked change request; the server rejects them otherwise.
    const evidence = changeRequestId
      ? {
          change_request_id: changeRequestId,
          evidence_type: evidenceType || null,
          evidence_result: evidenceType ? evidenceResult || null : null,
          tested_by_label: testedBy.trim() || null,
          tested_at: testedAt ? new Date(testedAt + "T12:00:00").toISOString() : null,
          evidence_note: evidenceNote.trim() || null,
        }
      : {};
    const clientResult = createDocumentSchema.safeParse({
      title: title.trim(),
      doc_type: docType,
      status,
      folder: folder.trim() || "General",
      project_id: projectId || null,
      summary: summary.trim() || null,
      body: body.trim() || null,
      external_url: externalUrl.trim() || null,
      ...evidence,
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
      doc_type: docType,
      status,
      folder: folder.trim() || "General",
      project_id: projectId || null,
      summary: summary.trim() || null,
      body: body.trim() || null,
      external_url: externalUrl.trim() || null,
      ...evidence,
    };

    try {
      if (document) {
        await apiPatch(`/api/documents/${document.id}`, payload);
        toast.success("Document updated");
      } else {
        await apiPost("/api/documents", payload);
        toast.success("Document added");
      }
      router.refresh();
      inspector.close();
    } catch (err) {
      applyApiError(err as ApiError);
      toast.error((err as ApiError).message ?? "Failed to save document");
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <FormError message={topError} />

      {/* Title — prominent */}
      <TitleField
        label="Document title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Document title"
        required
        error={fieldErrors.title}
      />

      {/* Compact properties grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
        {/* Doc Type */}
        <Field label="Type" error={fieldErrors.doc_type}>
          <SelectInput
            value={docType}
            onChange={(e) => setDocType(e.target.value as DocType)}
          >
            {DOC_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        {/* Status */}
        <Field label="Status" error={fieldErrors.status}>
          <SelectInput
            value={status}
            onChange={(e) => setStatus(e.target.value as DocStatus)}
          >
            {STATUS_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </SelectInput>
        </Field>

        {/* Folder */}
        <Field label="Folder" error={fieldErrors.folder}>
          <Input
            list="folder-suggestions"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="e.g. Charter, RAID"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
        </Field>
        <datalist id="folder-suggestions">
          {FOLDER_SUGGESTIONS.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>

        {/* Project (optional) */}
        {projects && projects.length > 0 && (
          <Field label="Project" error={fieldErrors.project_id}>
            <SelectInput
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">— Workspace-level —</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectInput>
          </Field>
        )}
      </div>

      {/* External URL */}
      <Field label="External Link" error={fieldErrors.external_url}>
        <Input
          type="url"
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          placeholder="https://docs.google.com/…"
          className="h-11 sm:h-10 text-base sm:text-sm"
        />
      </Field>

      {/* Evidence — only when linked to a change request */}
      {changeRequestId && (
        <fieldset className="space-y-3 rounded-lg border border-border-subtle bg-well p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-ink-muted">
            Evidence{evidenceFor ? ` for ${evidenceFor.reference_id ?? "change request"}` : ""}
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Evidence type" error={fieldErrors.evidence_type}>
              <SelectInput value={evidenceType} onChange={(e) => setEvidenceType(e.target.value)}>
                <option value="">— Not set —</option>
                {EVIDENCE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {EVIDENCE_TYPE_LABELS[t]}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Result" error={fieldErrors.evidence_result}>
              <SelectInput
                value={evidenceResult}
                onChange={(e) => setEvidenceResult(e.target.value)}
                disabled={!evidenceType}
              >
                <option value="">— Not set —</option>
                {EVIDENCE_RESULTS.map((r) => (
                  <option key={r} value={r}>
                    {EVIDENCE_RESULT_LABELS[r]}
                  </option>
                ))}
              </SelectInput>
            </Field>
            <Field label="Tested by" error={fieldErrors.tested_by_label}>
              <Input
                value={testedBy}
                onChange={(e) => setTestedBy(e.target.value)}
                placeholder="Defaults to you"
                className="h-11 sm:h-10 text-base sm:text-sm"
              />
            </Field>
            <Field label="Tested on" error={fieldErrors.tested_at}>
              <Input
                type="date"
                value={testedAt}
                onChange={(e) => setTestedAt(e.target.value)}
                className="h-11 sm:h-10 text-base sm:text-sm"
              />
            </Field>
          </div>
          <Field label="Evidence note" error={fieldErrors.evidence_note}>
            <TextareaInput
              value={evidenceNote}
              onChange={(e) => setEvidenceNote(e.target.value)}
              placeholder="What was tested, on which build, and what was seen"
              rows={2}
            />
          </Field>
        </fieldset>
      )}

      {/* Summary — progressive disclosure */}
      {showSummary ? (
        <Field label="Summary" error={fieldErrors.summary}>
          <TextareaInput
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One-paragraph summary of this document…"
            rows={2}
          />
        </Field>
      ) : (
        <button
          type="button"
          onClick={() => setShowSummary(true)}
          className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
        >
          + Add summary
        </button>
      )}

      {/* Body — progressive disclosure */}
      {showBody ? (
        <Field label="Body (Markdown)" error={fieldErrors.body}>
          <TextareaInput
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Full document content in Markdown…"
            rows={8}
            className="font-mono text-sm"
          />
        </Field>
      ) : (
        <button
          type="button"
          onClick={() => setShowBody(true)}
          className="focus-ring inline-flex min-h-[44px] items-center rounded text-xs text-ink-muted transition-colors duration-200 hover:text-ink sm:min-h-0"
        >
          + Add body content
        </button>
      )}

      {/* Actions */}
      <div className="flex flex-col-reverse gap-2 border-t border-border-subtle pt-3 sm:flex-row sm:justify-end">
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
          disabled={saving}
          className="w-full sm:w-auto h-11 sm:h-10"
        >
          {saving ? (
            <>
              <Spinner size="sm" className="mr-2" />
              Saving…
            </>
          ) : document ? (
            "Save Changes"
          ) : (
            "Add Document"
          )}
        </Button>
      </div>
    </form>
  );
}
