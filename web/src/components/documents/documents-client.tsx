"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { FolderTree, type FolderTreeSelection } from "./folder-tree";
import { DocumentRowButton, DocumentViewer } from "./document-viewer";
import { DocumentForm, type Document, type DocStatus, type DocType } from "./document-form";

// ── Label maps ────────────────────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

function statusTone(s: DocStatus): BadgeTone {
  switch (s) {
    case "draft":      return "neutral";
    case "in_review":  return "warning";
    case "approved":   return "success";
    case "archived":   return "info";
  }
}

const STATUS_LABELS: Record<DocStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  approved: "Approved",
  archived: "Archived",
};

const DOC_TYPE_LABELS: Record<DocType, string> = {
  charter: "Charter",
  plan: "Plan",
  raid: "RAID Log",
  status_report: "Status Report",
  change_request: "Change Request",
  minutes: "Minutes",
  spec: "Specification",
  other: "Other",
};

function formatDate(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface DocumentsClientProps {
  documents: Document[];
  projects: { id: string; name: string }[];
  projectMap: Record<string, string>;
  ownerMap: Record<string, string>;
}

// ── DocumentsClient ───────────────────────────────────────────────────────────

export function DocumentsClient({
  documents,
  projects,
  projectMap,
  ownerMap,
}: DocumentsClientProps) {
  const inspector = useInspector();
  const searchParams = useSearchParams();

  const [selection, setSelection] = useState<FolderTreeSelection>({
    folder: null,
    docType: null,
  });

  // Honour ?doc={id} deep-link (from Review Queue)
  useEffect(() => {
    const docId = searchParams.get("doc");
    if (!docId) return;
    const doc = documents.find((d) => d.id === docId);
    if (!doc) return;
    inspector.open(
      <DocumentViewer
        document={doc}
        projectName={doc.project_id ? (projectMap[doc.project_id] ?? undefined) : undefined}
        ownerName={doc.owner_id ? (ownerMap[doc.owner_id] ?? undefined) : undefined}
        projects={projects}
      />,
      doc.reference_id ? `Doc ${doc.reference_id}` : "Document",
    );
    // Only auto-open once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Filter documents based on folder-tree selection
  const filtered = documents.filter((doc) => {
    if (selection.folder !== null && doc.folder !== selection.folder) return false;
    if (selection.docType !== null && doc.doc_type !== selection.docType) return false;
    return true;
  });

  function openNew() {
    inspector.open(
      <DocumentForm
        projects={projects}
        defaultFolder={selection.folder ?? undefined}
      />,
      "New Document",
    );
  }

  function ownerName(ownerId: string | null) {
    if (!ownerId) return undefined;
    return ownerMap[ownerId];
  }

  return (
    <div className="flex gap-0 min-h-0">
      {/* ── Folder tree sidebar ──────────────────────────────────────────────── */}
      <aside className="hidden md:block w-48 lg:w-56 shrink-0 border-r border-border-subtle bg-canvas px-3 py-4">
        <p className="mb-2 px-2.5 text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
          Folders
        </p>
        <FolderTree
          docs={documents}
          selection={selection}
          onSelect={setSelection}
        />
      </aside>

      {/* ── Main list ────────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0">
        {/* Toolbar */}
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3 md:hidden">
          {/* Mobile: show active folder chip */}
          {selection.folder ? (
            <button
              type="button"
              onClick={() => setSelection({ folder: null, docType: null })}
              className="text-xs text-ink-muted hover:text-ink"
            >
              ← {selection.folder}
            </button>
          ) : (
            <span className="text-xs text-ink-muted">All documents</span>
          )}
          <Button variant="primary" className="h-9 px-3 text-xs" onClick={openNew}>
            <Plus size={14} className="mr-1" />
            New
          </Button>
        </div>

        {/* Document table */}
        {filtered.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Ref
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Title
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide hidden sm:table-cell">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide">
                    Status
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide hidden lg:table-cell">
                    Project
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-ink-muted uppercase tracking-wide hidden lg:table-cell">
                    Updated
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.map((doc) => (
                  <DocumentRowButton
                    key={doc.id}
                    document={doc}
                    projectName={doc.project_id ? (projectMap[doc.project_id] ?? undefined) : undefined}
                    ownerName={ownerName(doc.owner_id)}
                    projects={projects}
                  >
                    <td className="px-4 py-3.5">
                      {doc.reference_id ? (
                        <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
                          {doc.reference_id}
                        </span>
                      ) : (
                        <span className="text-ink-muted">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3.5">
                      <span className="font-medium text-ink">{doc.title}</span>
                      {doc.summary && (
                        <p className="mt-0.5 text-xs text-ink-muted truncate max-w-[28ch]">
                          {doc.summary}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3.5 text-ink-secondary hidden sm:table-cell">
                      {DOC_TYPE_LABELS[doc.doc_type as DocType] ?? doc.doc_type}
                    </td>
                    <td className="px-4 py-3.5">
                      <Badge tone={statusTone(doc.status as DocStatus)}>
                        {STATUS_LABELS[doc.status as DocStatus] ?? doc.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3.5 text-ink-secondary hidden lg:table-cell">
                      {doc.project_id ? (projectMap[doc.project_id] ?? "—") : "—"}
                    </td>
                    <td className="px-4 py-3.5 text-ink-secondary tabular-nums hidden lg:table-cell">
                      {formatDate(doc.updated_at)}
                    </td>
                  </DocumentRowButton>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-ink-muted">
              {documents.length === 0
                ? "No documents recorded yet."
                : "No documents match the selected filter."}
            </p>
            {documents.length === 0 && (
              <p className="mt-1 text-xs text-ink-muted">
                Use &quot;New Document&quot; to add the first one.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── NewDocumentButton — opens the form in the right push-panel ────────────────

export function NewDocumentButton({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const inspector = useInspector();

  function openNew() {
    inspector.open(
      <DocumentForm projects={projects} />,
      "New Document",
    );
  }

  return (
    <Button variant="primary" className="h-11 sm:h-10" onClick={openNew}>
      <Plus size={16} className="mr-1.5" />
      New Document
    </Button>
  );
}
