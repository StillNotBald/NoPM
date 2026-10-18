"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useInspector } from "@/components/layout/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { HistoryTimeline } from "@/components/tracking/history-timeline";
import { formatByPref, type DateDisplayPref } from "@/lib/format/dates";
import { DocumentForm, type Document, type DocStatus, type DocType } from "./document-form";
import { FileUpload } from "./file-upload";

// ── Status and type helpers ───────────────────────────────────────────────────

type BadgeTone = "neutral" | "accent" | "info" | "success" | "warning" | "danger";

function statusTone(s: DocStatus): BadgeTone {
  switch (s) {
    case "draft":
      return "neutral";
    case "in_review":
      return "warning";
    case "approved":
      return "success";
    case "archived":
      return "info";
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

// ── Detail row primitive ──────────────────────────────────────────────────────

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 border-b border-border-subtle last:border-0">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

function TextValue({ value }: { value: string | null | undefined }) {
  if (!value || value.trim() === "") {
    return <span className="text-ink-muted">—</span>;
  }
  return <span className="whitespace-pre-wrap">{value}</span>;
}

/** Only web and mail links are rendered as links; anything else (javascript:, data:, ...) stays inert text. */
function isSafeHref(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url.trim());
}

// ── Simple Markdown renderer (no external deps) ───────────────────────────────
// Handles: # ## ### headings, **bold**, *italic*, `inline code`, ```fences```,
// [text](url) links, - bullet lists, 1. ordered lists, --- horizontal rules.

function parseInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Pattern: **bold** | *italic* | `code` | [label](url)
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2] !== undefined) {
      parts.push(<strong key={match.index}>{match[2]}</strong>);
    } else if (match[3] !== undefined) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4] !== undefined) {
      parts.push(
        <code key={match.index} className="rounded bg-well px-1 py-0.5 font-mono text-xs text-ink">
          {match[4]}
        </code>,
      );
    } else if (match[5] !== undefined && match[6] !== undefined) {
      parts.push(
        isSafeHref(match[6]) ? (
          <a key={match.index} href={match[6]} target="_blank" rel="noopener noreferrer"
            className="text-accent underline underline-offset-2">
            {match[5]}
          </a>
        ) : (
          <span key={match.index}>{match[5]}</span>
        ),
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 ? parts[0] : <>{parts}</>;
}

function renderMarkdown(md: string): React.ReactNode {
  const lines = md.split("\n");
  const nodes: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence (``` block)
    if (line.startsWith("```")) {
      const fenceLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        fenceLines.push(lines[i]);
        i++;
      }
      nodes.push(
        <pre key={`fence-${i}`} className="my-2 overflow-x-auto rounded-md bg-well p-3 font-mono text-xs text-ink">
          <code>{fenceLines.join("\n")}</code>
        </pre>,
      );
      i++; // skip closing ```
      continue;
    }

    // Heading ### h3
    const h3 = line.match(/^### (.+)/);
    if (h3) {
      nodes.push(<h5 key={`h3-${i}`} className="mt-3 text-sm font-semibold text-ink">{parseInline(h3[1])}</h5>);
      i++; continue;
    }

    // Heading ## h2
    const h2 = line.match(/^## (.+)/);
    if (h2) {
      nodes.push(<h4 key={`h2-${i}`} className="mt-4 text-base font-semibold text-ink">{parseInline(h2[1])}</h4>);
      i++; continue;
    }

    // Heading # h1
    const h1 = line.match(/^# (.+)/);
    if (h1) {
      nodes.push(<h3 key={`h1-${i}`} className="mt-4 text-lg font-bold text-ink">{parseInline(h1[1])}</h3>);
      i++; continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      nodes.push(<hr key={`hr-${i}`} className="my-3 border-border-subtle" />);
      i++; continue;
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      nodes.push(
        <ul key={`ul-${i}`} className="my-1 ml-4 list-disc space-y-0.5 text-sm text-ink">
          {items.map((it, idx) => <li key={idx}>{parseInline(it)}</li>)}
        </ul>,
      );
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ""));
        i++;
      }
      nodes.push(
        <ol key={`ol-${i}`} className="my-1 ml-4 list-decimal space-y-0.5 text-sm text-ink">
          {items.map((it, idx) => <li key={idx}>{parseInline(it)}</li>)}
        </ol>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      nodes.push(<div key={`gap-${i}`} className="my-1" />);
      i++; continue;
    }

    // Paragraph
    nodes.push(
      <p key={`p-${i}`} className="text-sm leading-relaxed text-ink">
        {parseInline(line)}
      </p>,
    );
    i++;
  }

  return <>{nodes}</>;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ── FileSection ───────────────────────────────────────────────────────────────

function FileSection({
  document,
  onChanged,
}: {
  document: Document;
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const hasFile = !!document.storage_path;
  const fileUrl = `/api/documents/${document.id}/file`;

  async function handleRemove() {
    setConfirmingRemove(false);
    setRemoveError(null);
    setRemoving(true);
    try {
      const res = await fetch(fileUrl, { method: "DELETE" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Remove failed (${res.status})`);
      }
      onChanged();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Remove failed.");
      setRemoving(false);
    }
  }

  return (
    <div className="mt-4 border-t border-border-subtle pt-4">
      <h3 className="text-2xs font-medium uppercase tracking-wide text-ink-muted mb-3">
        File
      </h3>

      {hasFile ? (
        <div className="flex flex-col gap-3">
          {/* PDF inline preview */}
          {document.mime_type?.startsWith("application/pdf") && (
            <iframe
              src={fileUrl}
              title={document.file_name ?? "Document PDF"}
              className="w-full rounded-md border border-border-subtle bg-well"
              style={{ height: "60vh" }}
            />
          )}

          {/* Image inline preview */}
          {document.mime_type?.startsWith("image/") && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fileUrl}
              alt={document.file_name ?? "Attached image"}
              className="max-w-full rounded-md border border-border-subtle object-contain"
              style={{ maxHeight: "60vh" }}
            />
          )}

          {/* Other types — download link */}
          {!document.mime_type?.startsWith("application/pdf") &&
            !document.mime_type?.startsWith("image/") && (
              <a
                href={fileUrl}
                download={document.file_name ?? undefined}
                className="inline-flex items-center gap-2 rounded-md border border-border-subtle bg-well px-3 py-2.5 text-sm text-ink hover:bg-canvas transition-colors duration-150 self-start"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="text-ink-secondary"
                  aria-hidden="true"
                >
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                <span className="font-medium truncate max-w-[28ch]">
                  {document.file_name ?? "Download file"}
                </span>
                {document.file_size != null && (
                  <span className="text-xs text-ink-muted shrink-0">
                    {humanSize(document.file_size)}
                  </span>
                )}
              </a>
            )}

          {/* File meta line */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {document.file_name && (
              <span className="font-mono truncate max-w-[28ch]">{document.file_name}</span>
            )}
            {document.file_size != null && (
              <span>{humanSize(document.file_size)}</span>
            )}
            {document.mime_type && (
              <span className="opacity-70">{document.mime_type}</span>
            )}
          </div>

          {/* Remove + Replace controls */}
          <div className="flex flex-wrap items-center gap-2">
            {confirmingRemove ? (
              // Removing a file deletes it from storage, so it takes a second, deliberate click.
              <span className="inline-flex flex-wrap items-center gap-1 text-xs text-ink">
                Remove this file?
                <button
                  type="button"
                  autoFocus
                  onClick={handleRemove}
                  className="focus-ring min-h-[44px] rounded px-2 font-medium text-danger-ink hover:bg-well sm:min-h-8"
                >
                  Remove
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingRemove(false)}
                  className="focus-ring min-h-[44px] rounded px-2 text-ink-secondary hover:bg-well sm:min-h-8"
                >
                  Keep
                </button>
              </span>
            ) : (
            <button
              type="button"
              onClick={() => setConfirmingRemove(true)}
              disabled={removing}
              className="focus-ring inline-flex min-h-[44px] items-center gap-1 rounded px-1 text-xs text-danger-ink transition-opacity duration-150 hover:opacity-80 disabled:opacity-50 sm:min-h-8"
            >
              {removing ? (
                <Spinner size="sm" className="text-danger-ink" />
              ) : (
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              )}
              {removing ? "Removing…" : "Remove file"}
            </button>
            )}

            <span className="text-ink-muted text-xs">·</span>

            {/* Replace = upload new file over the existing one */}
            <FileUpload documentId={document.id} onSuccess={onChanged} />
          </div>

          {removeError && (
            <p role="alert" className="text-xs text-danger-ink">
              {removeError}
            </p>
          )}
        </div>
      ) : (
        /* No file attached — show attach control */
        <FileUpload documentId={document.id} onSuccess={onChanged} />
      )}
    </div>
  );
}

// ── DocumentViewer ────────────────────────────────────────────────────────────

export interface DocumentViewerProps {
  document: Document;
  projectName?: string;
  ownerName?: string;
  projects?: { id: string; name: string }[];
  /** Same appearance preference the register list honours; absolute when omitted. */
  dateDisplayPref?: DateDisplayPref;
}

export function DocumentViewer({
  document,
  projectName,
  ownerName,
  projects,
  dateDisplayPref = "absolute",
}: DocumentViewerProps) {
  const inspector = useInspector();
  const router = useRouter();
  const formatDate = (iso: string | null | undefined) => formatByPref(iso, dateDisplayPref).text;

  function openEdit() {
    inspector.open(
      <DocumentForm document={document} projects={projects} />,
      "Edit Document",
    );
  }

  function handleFileChanged() {
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-0 pb-4">
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 pb-3 border-b border-border-subtle mb-1">
        <div className="flex-1 min-w-0">
          {document.reference_id && (
            <span className="font-mono text-[11px] bg-well border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted mb-1 inline-block">
              {document.reference_id}
            </span>
          )}
          <h2 className="text-base font-semibold text-ink leading-snug mt-0.5">
            {document.title}
          </h2>
        </div>
        <Button variant="ghost" onClick={openEdit} className="h-11 shrink-0 px-3 text-xs sm:h-9">
          Edit
        </Button>
      </div>

      {/* Status / type chips */}
      <div className="flex flex-wrap gap-2 py-2.5 border-b border-border-subtle">
        <Badge tone={statusTone(document.status as DocStatus)}>
          {STATUS_LABELS[document.status as DocStatus] ?? document.status}
        </Badge>
        <Badge tone="neutral">
          {DOC_TYPE_LABELS[document.doc_type as DocType] ?? document.doc_type}
        </Badge>
        <span className="font-mono text-xs text-ink-muted tabular-nums self-center">
          v{document.version}
        </span>
      </div>

      {/* Fields */}
      <div>
        <DetailRow label="Folder">
          <TextValue value={document.folder} />
        </DetailRow>

        <DetailRow label="Project">
          <TextValue value={projectName} />
        </DetailRow>

        <DetailRow label="Owner">
          <TextValue value={ownerName} />
        </DetailRow>

        <DetailRow label="Created">
          <span className="tabular-nums">{formatDate(document.created_at)}</span>
        </DetailRow>

        <DetailRow label="Last Updated">
          <span className="tabular-nums">{formatDate(document.updated_at)}</span>
        </DetailRow>

        {document.summary && document.summary.trim() !== "" && (
          <DetailRow label="Summary">
            <TextValue value={document.summary} />
          </DetailRow>
        )}

        {document.external_url && (
          <DetailRow label="External Link">
            {isSafeHref(document.external_url) ? (
              <a
                href={document.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent underline underline-offset-2 break-all text-sm"
              >
                {document.external_url}
              </a>
            ) : (
              <span className="break-all text-sm">{document.external_url}</span>
            )}
          </DetailRow>
        )}
      </div>

      {/* Body — markdown rendered */}
      {document.body && document.body.trim() !== "" && (
        <div className="mt-4 border-t border-border-subtle pt-4">
          <h3 className="text-2xs font-medium uppercase tracking-wide text-ink-muted mb-2">
            Content
          </h3>
          <div className="space-y-0.5">{renderMarkdown(document.body)}</div>
        </div>
      )}

      {/* File attachment */}
      <FileSection document={document} onChanged={handleFileChanged} />

      {/* Provenance — immutable audit trail */}
      <div className="mt-6 border-t border-border-subtle pt-4">
        <HistoryTimeline
          targetType="document"
          targetId={document.id}
          limit={20}
        />
      </div>
    </div>
  );
}

