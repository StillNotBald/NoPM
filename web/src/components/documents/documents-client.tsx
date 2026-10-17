"use client";

import { useEffect, useId, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { THead, TH, TR, TD } from "@/components/ui/data-table";
import { ScrollTable } from "@/components/registers/scroll-table";
import { selectClass } from "@/components/registers/filter-bar";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { cn } from "@/lib/cn";
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

// ── Props ─────────────────────────────────────────────────────────────────────

interface DocumentsClientProps {
  documents: Document[];
  projects: { id: string; name: string }[];
  projectMap: Record<string, string>;
  ownerMap: Record<string, string>;
  /** false for viewer-role callers — see risks/page.tsx (L-46). */
  canWrite?: boolean;
  /** Appearance preference (absolute | relative), as the other registers honour it. */
  dateDisplayPref?: DateDisplayPref;
}

// ── DocumentsClient ───────────────────────────────────────────────────────────

export function DocumentsClient({
  documents,
  projects,
  projectMap,
  ownerMap,
  canWrite = true,
  dateDisplayPref = "absolute",
}: DocumentsClientProps) {
  const inspector = useInspector();
  const searchParams = useSearchParams();
  const folderSelectId = useId();
  const formatDate = (iso: string | null | undefined) => formatByPref(iso, dateDisplayPref).text;

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
        dateDisplayPref={dateDisplayPref}
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
        dateDisplayPref={dateDisplayPref}
      />,
      doc.reference_id ? `Doc ${doc.reference_id}` : "Document",
    );
  }

  const folders = [...new Set(documents.map((d) => d.folder))].sort((x, y) => x.localeCompare(y));

  // <md card: the summary preview and Updated date stay visible on phones
  // instead of being dropped as ordinary secondary fields.
  function renderDocCard(doc: Document) {
    return (
      <div className="flex min-h-[44px] items-center gap-3 px-4 py-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-1.5">
            {doc.reference_id && (
              <span className="shrink-0 whitespace-nowrap font-mono text-2xs bg-sunken border border-border-subtle rounded px-1 py-0.5 text-ink-muted">
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
        {/* Phone folder picker: the tree sidebar is md+ only. The page header
            already carries "New Document", so there is no second New here. */}
        {folders.length > 0 && (
          <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3 md:hidden">
            <label
              htmlFor={folderSelectId}
              className="text-[11px] font-medium uppercase tracking-wide text-ink-muted"
            >
              Folder
            </label>
            <select
              id={folderSelectId}
              value={selection.folder ?? ""}
              onChange={(e) => setSelection({ folder: e.target.value || null, docType: null })}
              className={cn(selectClass, "min-w-0 flex-1")}
            >
              <option value="">All documents</option>
              {folders.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Document list: table at md+, cards below (F5) */}
        {filtered.length > 0 ? (
          <>
            <div className="hidden md:block">
              <ScrollTable bare label="Documents">
                <THead>
                  <TR>
                    <TH>Ref</TH>
                    <TH>Title</TH>
                    <TH>Type</TH>
                    <TH>Status</TH>
                    <TH>Project</TH>
                    <TH>Updated</TH>
                  </TR>
                </THead>
                <tbody>
                  {filtered.map((doc) => (
                    <TR
                      key={doc.id}
                      onClick={() => openDocument(doc)}
                      className="cursor-pointer transition-colors duration-100 hover:bg-sunken"
                    >
                      <TD className="whitespace-nowrap">
                        {doc.reference_id ? (
                          <span className="whitespace-nowrap rounded border border-border-subtle bg-sunken px-1.5 py-0.5 font-mono text-xs text-ink-muted">
                            {doc.reference_id}
                          </span>
                        ) : (
                          <span className="text-ink-muted">—</span>
                        )}
                      </TD>
                      <TD>
                        {/* The row click is a mouse convenience; this button is the keyboard / screen-reader way in. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDocument(doc);
                          }}
                          title={doc.title}
                          className="focus-ring block max-w-[16rem] truncate rounded text-left font-medium text-ink hover:text-accent"
                        >
                          {doc.title}
                        </button>
                        {doc.summary && (
                          <p className="mt-0.5 max-w-[16rem] truncate text-xs text-ink-muted">{doc.summary}</p>
                        )}
                      </TD>
                      <TD className="whitespace-nowrap text-ink-secondary">
                        {DOC_TYPE_LABELS[doc.doc_type as DocType] ?? doc.doc_type}
                      </TD>
                      <TD className="whitespace-nowrap">
                        <Badge tone={statusTone(doc.status as DocStatus)}>
                          {STATUS_LABELS[doc.status as DocStatus] ?? doc.status}
                        </Badge>
                      </TD>
                      <TD className="text-ink-secondary">
                        <span className="block max-w-[10rem] truncate">
                          {doc.project_id ? (projectMap[doc.project_id] ?? "—") : "—"}
                        </span>
                      </TD>
                      <TD className="whitespace-nowrap tabular-nums text-ink-secondary">
                        {formatDate(doc.updated_at)}
                      </TD>
                    </TR>
                  ))}
                </tbody>
              </ScrollTable>
            </div>

            <ul className="divide-y divide-border-subtle md:hidden">
              {filtered.map((doc) => (
                <li key={doc.id}>
                  <button
                    type="button"
                    onClick={() => openDocument(doc)}
                    className="focus-ring block w-full text-left"
                  >
                    {renderDocCard(doc)}
                  </button>
                </li>
              ))}
            </ul>
          </>
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
          <EmptyState
            purpose="No documents match the selected filter."
            action={
              <Button variant="secondary" size="sm" onClick={() => setSelection({ folder: null, docType: null })}>
                Show all documents
              </Button>
            }
          />
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
