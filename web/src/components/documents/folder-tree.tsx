"use client";

import { cn } from "@/lib/cn";
import type { Document, DocType } from "./document-form";

// ── Label maps ────────────────────────────────────────────────────────────────

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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FolderTreeSelection {
  folder: string | null;
  docType: DocType | null;
}

interface FolderNode {
  folder: string;
  docTypes: { docType: DocType; count: number }[];
  totalCount: number;
}

function buildTree(docs: Document[]): FolderNode[] {
  const folderMap = new Map<string, Map<DocType, number>>();

  for (const doc of docs) {
    if (!folderMap.has(doc.folder)) {
      folderMap.set(doc.folder, new Map());
    }
    const types = folderMap.get(doc.folder)!;
    types.set(doc.doc_type, (types.get(doc.doc_type) ?? 0) + 1);
  }

  const nodes: FolderNode[] = [];
  for (const [folder, types] of folderMap.entries()) {
    const docTypes = Array.from(types.entries())
      .map(([docType, count]) => ({ docType, count }))
      .sort((a, b) =>
        DOC_TYPE_LABELS[a.docType].localeCompare(DOC_TYPE_LABELS[b.docType]),
      );
    nodes.push({
      folder,
      docTypes,
      totalCount: docTypes.reduce((s, x) => s + x.count, 0),
    });
  }

  return nodes.sort((a, b) => a.folder.localeCompare(b.folder));
}

// ── FolderTree ────────────────────────────────────────────────────────────────

export function FolderTree({
  docs,
  selection,
  onSelect,
}: {
  docs: Document[];
  selection: FolderTreeSelection;
  onSelect: (sel: FolderTreeSelection) => void;
}) {
  const tree = buildTree(docs);
  const allCount = docs.length;

  function isActive(folder: string | null, docType: DocType | null) {
    return selection.folder === folder && selection.docType === docType;
  }

  return (
    <nav className="w-full" aria-label="Document folders">
      {/* All documents */}
      <button
        type="button"
        onClick={() => onSelect({ folder: null, docType: null })}
        className={cn(
          "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors duration-100",
          isActive(null, null)
            ? "bg-accent/10 text-accent font-medium"
            : "text-ink-secondary hover:bg-sunken",
        )}
      >
        <span>All documents</span>
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            isActive(null, null) ? "text-accent" : "text-ink-muted",
          )}
        >
          {allCount}
        </span>
      </button>

      {/* Folders */}
      {tree.map((node) => (
        <div key={node.folder} className="mt-1">
          {/* Folder row */}
          <button
            type="button"
            onClick={() => onSelect({ folder: node.folder, docType: null })}
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-sm transition-colors duration-100",
              isActive(node.folder, null)
                ? "bg-accent/10 text-accent font-medium"
                : "text-ink hover:bg-sunken",
            )}
          >
            <span className="flex items-center gap-1.5">
              <FolderIcon
                active={isActive(node.folder, null)}
                className="shrink-0"
              />
              {node.folder}
            </span>
            <span
              className={cn(
                "font-mono text-xs tabular-nums",
                isActive(node.folder, null) ? "text-accent" : "text-ink-muted",
              )}
            >
              {node.totalCount}
            </span>
          </button>

          {/* Doc-type sub-rows */}
          {node.docTypes.length > 1 &&
            node.docTypes.map(({ docType, count }) => (
              <button
                key={docType}
                type="button"
                onClick={() => onSelect({ folder: node.folder, docType })}
                className={cn(
                  "flex w-full items-center justify-between rounded-md py-1 pl-7 pr-2.5 text-xs transition-colors duration-100",
                  isActive(node.folder, docType)
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-ink-secondary hover:bg-sunken",
                )}
              >
                <span>{DOC_TYPE_LABELS[docType]}</span>
                <span
                  className={cn(
                    "font-mono tabular-nums",
                    isActive(node.folder, docType)
                      ? "text-accent"
                      : "text-ink-muted",
                  )}
                >
                  {count}
                </span>
              </button>
            ))}
        </div>
      ))}

      {allCount === 0 && (
        <p className="px-2.5 py-2 text-xs text-ink-muted">No documents yet.</p>
      )}
    </nav>
  );
}

// ── Tiny SVG folder icon ──────────────────────────────────────────────────────

function FolderIcon({
  active,
  className,
}: {
  active?: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      fill="none"
      className={cn(active ? "text-accent" : "text-ink-muted", className)}
      aria-hidden
    >
      <path
        d="M1.5 3.5A1 1 0 0 1 2.5 2.5h4l1 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1V3.5Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
