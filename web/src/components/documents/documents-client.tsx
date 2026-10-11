"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { DataList, type DataListColumn } from "@/components/ui/data-list";
import { ChevronRight, Plus } from "lucide-react";
import { FolderTree, type FolderTreeSelection } from "./folder-tree";
import { DocumentViewer } from "./document-viewer";
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
  /** false for viewer-role callers — see risks/page.tsx (L-46). */
  canWrite?: boolean;
}

// ── DocumentsClient ───────────────────────────────────────────────────────────

export function DocumentsClient({
  documents,
  projects,
  projectMap,
  ownerMap,
  canWrite = true,
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

  function openDocument(doc: Document) {
    inspector.open(
      <DocumentViewer
        document={doc}
        projectName={doc.project_id ? (projectMap[doc.project_id] ?? undefined) : undefined}
        ownerName={ownerName(doc.owner_id)}
        projects={projects}
      />,
      doc.reference_id ? `Doc ${doc.reference_id}` : "Document",
    );
  }

  // Column order mirrors the ≥md table exactly; the <md card uses a fully
  // custom renderCard (below) so the summary preview and Updated date stay
  // visible on phones instead of being dropped as ordinary secondary fields.
  const columns: DataListColumn<Document>[] = [
    {
      key: "ref",
      header: "Ref",
      cell: (doc) =>
        doc.reference_id ? (
          <span className="font-mono text-xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
            {doc.reference_id}
          </span>
        ) : (
          <span className="text-ink-muted">—</span>
        ),
    },
    {
      key: "title",
      header: "Title",
      primary: true,
      cell: (doc) => (
        <>
          <span className="font-medium text-ink">{doc.title}</span>
          {doc.summary && (
            <p className="mt-0.5 max-w-[28ch] truncate text-xs text-ink-muted">{doc.summary}</p>
          )}
        </>
      ),
    },
    {
      key: "type",
      header: "Type",
      cell: (doc) => (
        <span className="text-ink-secondary">{DOC_TYPE_LABELS[doc.doc_type as DocType] ?? doc.doc_type}</span>
      ),
    },
    {
      key: "status",
      header: "Status",
      badge: true,
      cell: (doc) => (
        <Badge tone={statusTone(doc.status as DocStatus)}>
          {STATUS_LABELS[doc.status as DocStatus] ?? doc.status}
        </Badge>
      ),
    },
    {
      key: "project",
      header: "Project",
      cell: (doc) => (
        <span className="text-ink-secondary">{doc.project_id ? (projectMap[doc.project_id] ?? "—") : "—"}</span>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      cell: (doc) => (
        <span className="text-ink-secondary tabular-nums">{formatDate(doc.updated_at)}</span>
      ),
    },
  ];

  function renderDocCard(doc: Document) {
    return (
      <div className="flex min-h-[44px] items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            {doc.reference_id && (
              <span className="shrink-0 font-mono text-2xs bg-sunken border border-border-subtle rounded px-1 py-0.5 text-ink-muted">
                {doc.reference_id}
              </span>
            )}
            <span className="truncate text-sm font-medium text-ink">{doc.title}</span>
          </div>
          {doc.summary && <p className="truncate text-xs text-ink-muted">{doc.summary}</p>}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={statusTone(doc.status as DocStatus)}>
              {STATUS_LABELS[doc.status as DocStatus] ?? doc.status}
            </Badge>
            <span className="text-xs text-ink-muted">
              {DOC_TYPE_LABELS[doc.doc_type as DocType] ?? doc.doc_type}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5 text-xs">
            <span className="text-ink-muted">Updated</span>
            <span className="text-ink-secondary tabular-nums">{formatDate(doc.updated_at)}</span>
          </div>
        </div>
        <ChevronRight size={18} className="shrink-0 text-ink-muted" aria-hidden="true" />
      </div>
    );
  }

  return (
    <div className="flex gap-0 min-h-0">
      {/* ── Folder tree sidebar ──────────────────────────────────────────────── */}
      <aside className="hidden md:block w-48 lg:w-56 shrink-0 border-r border-border-subtle bg-canvas px-3 py-4">
        <p className="mb-2 px-2.5 text-2xs font-semibold uppercase tracking-wider text-ink-muted">
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

        {/* Document list — table ≥md, cards <md (F5) */}
        {filtered.length > 0 ? (
          <DataList
            columns={columns}
            rows={filtered}
            rowKey={(doc) => doc.id}
            onRowClick={openDocument}
            renderCard={renderDocCard}
            tableClassName="min-w-[600px]"
          />
        ) : documents.length === 0 ? (
          <EmptyState
            purpose="Documents hold the durable artifacts of the project — charters, plans, RAID logs, status reports — versioned and linked back to the project they belong to."
            canWrite={canWrite}
            action={
              <Button variant="secondary" size="sm" onClick={openNew}>
                <Plus size={14} className="mr-1" />
                New Document
              </Button>
            }
            docsHref="/trust"
            docsLabel="See governance in the Trust Center"
          />
        ) : (
          <p className="px-5 py-16 text-center text-sm text-ink-muted">
            No documents match the selected filter.
          </p>
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
