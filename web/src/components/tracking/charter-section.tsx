"use client";

import Link from "next/link";
import { FileText, ExternalLink, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/card";
import { ragLabel, ragTone, type RagStatus } from "@/lib/status";
import { cn } from "@/lib/cn";

// ── Data shapes ────────────────────────────────────────────────────────────────

export interface CharterProject {
  id: string;
  code: string | null;
  name: string;
  program: string | null;
  rag_status: string;
  completion_pct: number;
  start_date: string | null;
  target_date: string | null;
  currency: string;
}

export interface CharterDocument {
  id: string;
  workspace_id: string;
  project_id: string | null;
  reference_id: string | null;
  folder: string | null;
  title: string;
  doc_type: string;
  status: string | null;
  version: number | null;
  summary: string | null;
  body: string | null;
  external_url: string | null;
  owner_id: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function docStatusTone(s: string | null): "neutral" | "success" | "info" | "warning" {
  if (!s) return "neutral";
  switch (s.toLowerCase()) {
    case "approved":   return "success";
    case "active":     return "success";
    case "final":      return "success";
    case "draft":      return "info";
    case "review":     return "warning";
    case "in_review":  return "warning";
    case "archived":   return "neutral";
    default:           return "neutral";
  }
}

function bodyPreview(body: string | null, maxLen = 200): string | null {
  if (!body || body.trim() === "") return null;
  const text = body.replace(/#+\s/g, "").replace(/\*\*/g, "").replace(/\n+/g, " ").trim();
  return text.length > maxLen ? text.slice(0, maxLen) + "…" : text;
}

// ── MetaRow — a labelled field row ────────────────────────────────────────────

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-2xs font-medium uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <div className="text-sm text-ink">{children}</div>
    </div>
  );
}

// ── CharterSection ─────────────────────────────────────────────────────────────

export function CharterSection({
  project,
  charterDoc,
}: {
  project: CharterProject;
  charterDoc: CharterDocument | null;
}) {
  const rag = project.rag_status as RagStatus;

  return (
    <div className="space-y-6">
      {/* Project meta block */}
      <Card>
        <CardHeader>
          <CardTitle>Project information</CardTitle>
          <Badge tone={ragTone(rag)}>{ragLabel(rag)}</Badge>
        </CardHeader>
        <CardBody>
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3 lg:grid-cols-4">
            {project.program && (
              <MetaRow label="Program">
                <span>{project.program}</span>
              </MetaRow>
            )}

            <MetaRow label="RAG status">
              <Badge tone={ragTone(rag)}>{ragLabel(rag)}</Badge>
            </MetaRow>

            <MetaRow label="Completion">
              <span className="font-mono tabular-nums">
                {Math.round(project.completion_pct)}%
              </span>
            </MetaRow>

            <MetaRow label="Start date">
              <span className="font-mono tabular-nums text-ink-secondary">
                {fmtDate(project.start_date)}
              </span>
            </MetaRow>

            <MetaRow label="Target date">
              <span className="font-mono tabular-nums text-ink-secondary">
                {fmtDate(project.target_date)}
              </span>
            </MetaRow>

            <MetaRow label="Currency">
              <span className="font-mono tabular-nums text-ink-secondary">
                {project.currency}
              </span>
            </MetaRow>
          </div>
        </CardBody>
      </Card>

      {/* Charter document card */}
      {charterDoc ? (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <FileText size={14} className="text-ink-muted shrink-0" />
              <CardTitle>Charter document</CardTitle>
              {charterDoc.reference_id && (
                <span className="font-mono text-2xs bg-sunken border border-border-subtle rounded px-1.5 py-0.5 text-ink-muted">
                  {charterDoc.reference_id}
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              {charterDoc.status && (
                <Badge tone={docStatusTone(charterDoc.status)} className="capitalize">
                  {charterDoc.status.replace(/_/g, " ")}
                </Badge>
              )}
              {charterDoc.version != null && (
                <span className="font-mono text-2xs text-ink-muted">
                  v{charterDoc.version}
                </span>
              )}
            </div>
          </CardHeader>

          <CardBody className="space-y-4">
            {/* Title */}
            <div>
              <h3 className="text-base font-semibold text-ink">{charterDoc.title}</h3>
              <p className="mt-0.5 font-mono text-2xs text-ink-muted">
                Created {fmtDate(charterDoc.created_at)}
              </p>
            </div>

            {/* Summary */}
            {charterDoc.summary && charterDoc.summary.trim() !== "" && (
              <div className="rounded-lg bg-sunken border border-border-subtle px-4 py-3">
                <p className="text-2xs font-medium uppercase tracking-wide text-ink-muted mb-1">
                  Summary
                </p>
                <p className="text-sm text-ink-secondary leading-relaxed">
                  {charterDoc.summary}
                </p>
              </div>
            )}

            {/* Body preview */}
            {(() => {
              const preview = bodyPreview(charterDoc.body);
              return preview ? (
                <p className="text-sm text-ink-muted leading-relaxed line-clamp-3">
                  {preview}
                </p>
              ) : null;
            })()}

            {/* Deep-link button */}
            <div className="pt-1">
              <Link href={`/documents?doc=${charterDoc.id}`}>
                <Button variant="secondary" size="sm" className="gap-1.5">
                  <ExternalLink size={12} />
                  Open full document
                </Button>
              </Link>
            </div>
          </CardBody>
        </Card>
      ) : (
        /* Empty state */
        <div className="flex flex-col items-center gap-3 rounded-xl border border-border-subtle bg-surface py-16 text-center">
          <FileText size={32} className="text-ink-muted opacity-30" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-ink-secondary">No charter document yet</p>
            <p className="text-xs text-ink-muted">
              Link a charter document to this project from the Documents register.
            </p>
          </div>
          <Link href="/documents">
            <Button variant="secondary" size="sm" className={cn("gap-1.5 mt-1")}>
              <Plus size={12} />
              Create charter
            </Button>
          </Link>
        </div>
      )}
    </div>
  );
}
