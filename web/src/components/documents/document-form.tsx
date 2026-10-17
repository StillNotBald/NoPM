"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { apiPost, apiPatch, type ApiError } from "@/lib/api-client";
import {
  FieldLabel,
  FieldError,
  SelectInput,
  TextareaInput,
} from "@/components/forms/project-form";
import { createDocumentSchema } from "@/app/api/documents/_schema";

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
}

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
}: {
  document?: Document;
  projects?: Project[];
  defaultProjectId?: string;
  defaultFolder?: string;
}) {
  const inspector = useInspector();
  const router = useRouter();
  const toast = useToast();

  const [title, setTitle] = useState(document?.title ?? "");
  const [docType, setDocType] = useState<DocType>(document?.doc_type ?? "other");
  const [status, setStatus] = useState<DocStatus>(document?.status ?? "draft");
  const [folder, setFolder] = useState(
    document?.folder ?? defaultFolder ?? "General",
  );
  const [projectId, setProjectId] = useState(
    document?.project_id ?? defaultProjectId ?? "",
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
    const clientResult = createDocumentSchema.safeParse({
      title: title.trim(),
      doc_type: docType,
      status,
      folder: folder.trim() || "General",
      project_id: projectId || null,
      summary: summary.trim() || null,
      body: body.trim() || null,
      external_url: externalUrl.trim() || null,
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
          placeholder="Document title"
          required
          className="border-0 border-b border-border-subtle bg-transparent px-0 text-lg font-medium text-ink placeholder:text-ink-muted/60 rounded-none focus-visible:ring-0 focus-visible:border-border-strong"
        />
        <FieldError message={fieldErrors.title} />
      </div>

      {/* Compact properties grid */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 pt-1">
        {/* Doc Type */}
        <div>
          <FieldLabel>Type</FieldLabel>
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
          <FieldError message={fieldErrors.doc_type} />
        </div>

        {/* Status */}
        <div>
          <FieldLabel>Status</FieldLabel>
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
          <FieldError message={fieldErrors.status} />
        </div>

        {/* Folder */}
        <div>
          <FieldLabel>Folder</FieldLabel>
          <Input
            list="folder-suggestions"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder="e.g. Charter, RAID"
            className="h-11 sm:h-10 text-base sm:text-sm"
          />
          <datalist id="folder-suggestions">
            {FOLDER_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <FieldError message={fieldErrors.folder} />
        </div>

        {/* Project (optional) */}
        {projects && projects.length > 0 && (
          <div>
            <FieldLabel>Project</FieldLabel>
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
            <FieldError message={fieldErrors.project_id} />
          </div>
        )}
      </div>

      {/* External URL */}
      <div>
        <FieldLabel>External Link</FieldLabel>
        <Input
          type="url"
          value={externalUrl}
          onChange={(e) => setExternalUrl(e.target.value)}
          placeholder="https://docs.google.com/…"
          className="h-11 sm:h-10 text-base sm:text-sm"
        />
        <FieldError message={fieldErrors.external_url} />
      </div>

      {/* Summary — progressive disclosure */}
      {showSummary ? (
        <div>
          <FieldLabel>Summary</FieldLabel>
          <TextareaInput
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
            placeholder="One-paragraph summary of this document…"
            rows={2}
          />
          <FieldError message={fieldErrors.summary} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowSummary(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
        >
          + Add summary
        </button>
      )}

      {/* Body — progressive disclosure */}
      {showBody ? (
        <div>
          <FieldLabel>Body (Markdown)</FieldLabel>
          <TextareaInput
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Full document content in Markdown…"
            rows={8}
            className="font-mono text-sm"
          />
          <FieldError message={fieldErrors.body} />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowBody(true)}
          className="text-[12px] text-ink-muted hover:text-ink transition-colors duration-200"
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
          disabled={saving || !title.trim()}
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
